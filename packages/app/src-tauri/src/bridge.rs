//! WebSocket 桥：WebView2 的 WebSocket 走系统代理，本地回环连接会被代理软件
//! 拒绝（net::ERR_CONNECTION_REFUSED）。所有 ws:// 流量改由 Rust 直连，
//! 事件经 Channel 推回前端，与 plugin-http 的 HTTP 桥同一个思路。
//!
//! 连接按 (window label, bridge id) 键控：多窗口场景下窗口销毁时能精确清理
//! 该窗口的所有连接，避免 Rust 侧 WS 任务泄漏。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

/// 复合键：(window label, bridge id)。同一窗口内 id 唯一；不同窗口可复用 id。
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct BridgeKey {
    window_label: String,
    bridge_id: u32,
}

#[derive(Default)]
pub struct BridgeState {
    next_id: AtomicU32,
    senders: Mutex<HashMap<BridgeKey, UnboundedSender<Message>>>,
}

impl BridgeState {
    /// 分配下一个连接 id（全局递增，避免跨窗口撞号）。
    pub fn next_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
    }

    fn insert(&self, key: BridgeKey, sender: UnboundedSender<Message>) {
        self.senders
            .lock()
            .expect("bridge state poisoned")
            .insert(key, sender);
    }

    fn sender(&self, key: &BridgeKey) -> Option<UnboundedSender<Message>> {
        self.senders
            .lock()
            .expect("bridge state poisoned")
            .get(key)
            .cloned()
    }

    fn remove(&self, key: &BridgeKey) -> Option<UnboundedSender<Message>> {
        self.senders
            .lock()
            .expect("bridge state poisoned")
            .remove(key)
    }

    /// 窗口销毁时清理该窗口全部桥接连接（发送 Close 让读循环退出）。
    pub fn disconnect_window(&self, window_label: &str) {
        let removed = {
            let mut guard = self.senders.lock().expect("bridge state poisoned");
            let keys: Vec<_> = guard
                .keys()
                .filter(|key| key.window_label == window_label)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| guard.remove(&key))
                .collect::<Vec<_>>()
        };
        for sender in removed {
            let _ = sender.send(Message::Close(None));
        }
    }
}

#[tauri::command]
pub async fn ws_bridge_connect(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, BridgeState>,
    url: String,
    on_event: Channel<Value>,
) -> Result<u32, String> {
    let (socket, _) = connect_async(&url)
        .await
        .map_err(|error| format!("WebSocket connect failed: {error}"))?;
    let (mut writer, mut reader) = socket.split();

    let id = state.next_id();
    let key = BridgeKey {
        window_label: window.label().to_string(),
        bridge_id: id,
    };
    let (tx, mut rx) = unbounded_channel::<Message>();
    state.insert(key.clone(), tx);

    // 写循环：从 channel 取消息发往远端；Close 帧发出后退出。
    tauri::async_runtime::spawn(async move {
        while let Some(message) = rx.recv().await {
            let is_close = matches!(message, Message::Close(_));
            if writer.send(message).await.is_err() {
                break;
            }
            if is_close {
                break;
            }
        }
    });

    if on_event.send(json!({ "type": "open" })).is_err() {
        state.remove(&key);
        return Err("WebSocket event channel is already closed".to_string());
    }

    let reader_app = app.clone();
    tauri::async_runtime::spawn(async move {
        // 1006 = abnormal closure，没有收到 close 帧时的兜底
        let mut close_payload = json!({ "type": "close", "code": 1006u32, "reason": "" });
        while let Some(frame) = reader.next().await {
            match frame {
                Ok(Message::Text(text)) => {
                    if on_event
                        .send(json!({ "type": "message", "data": text.to_string() }))
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(Message::Binary(bytes)) => {
                    let data = String::from_utf8_lossy(&bytes).to_string();
                    if on_event
                        .send(json!({ "type": "message", "data": data }))
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(Message::Close(frame)) => {
                    let code = frame
                        .as_ref()
                        .map(|frame| u16::from(frame.code) as u32)
                        .unwrap_or(1005);
                    let reason = frame
                        .map(|frame| frame.reason.to_string())
                        .unwrap_or_default();
                    close_payload = json!({ "type": "close", "code": code, "reason": reason });
                    break;
                }
                Ok(Message::Ping(payload)) => {
                    // split 之后 tungstenite 不会自动回 pong，显式回
                    let pong = reader_app
                        .state::<BridgeState>()
                        .sender(&key);
                    if let Some(sender) = pong {
                        let _ = sender.send(Message::Pong(payload));
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = on_event.send(json!({ "type": "error", "message": error.to_string() }));
                    break;
                }
            }
        }
        let _ = on_event.send(close_payload);
        reader_app.state::<BridgeState>().remove(&key);
    });

    Ok(id)
}

#[tauri::command]
pub fn ws_bridge_send(
    window: tauri::Window,
    state: State<'_, BridgeState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let key = BridgeKey {
        window_label: window.label().to_string(),
        bridge_id: id,
    };
    let sender = state
        .sender(&key)
        .ok_or_else(|| "WebSocket is not connected".to_string())?;
    sender
        .send(Message::Text(data.into()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ws_bridge_close(
    window: tauri::Window,
    state: State<'_, BridgeState>,
    id: u32,
    code: Option<u16>,
    reason: Option<String>,
) -> Result<(), String> {
    let key = BridgeKey {
        window_label: window.label().to_string(),
        bridge_id: id,
    };
    let sender = state.remove(&key);
    if let Some(sender) = sender {
        let frame = code.map(|code| CloseFrame {
            code: code.into(),
            reason: reason.unwrap_or_default().into(),
        });
        let _ = sender.send(Message::Close(frame));
    }
    Ok(())
}
