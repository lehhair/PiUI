//! WebSocket 桥：WebView2 的 WebSocket 走系统代理，本地回环连接会被代理软件
//! 拒绝（net::ERR_CONNECTION_REFUSED）。所有 ws:// 流量改由 Rust 直连，
//! 事件经 Channel 推回前端，与 plugin-http 的 HTTP 桥同一个思路。

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

#[derive(Default)]
pub struct BridgeState {
    next_id: AtomicU32,
    senders: Mutex<HashMap<u32, UnboundedSender<Message>>>,
}

#[tauri::command]
pub async fn ws_bridge_connect(
    app: AppHandle,
    state: State<'_, BridgeState>,
    url: String,
    on_event: Channel<Value>,
) -> Result<u32, String> {
    let (socket, _) = connect_async(&url)
        .await
        .map_err(|error| format!("WebSocket connect failed: {error}"))?;
    let (mut writer, mut reader) = socket.split();

    let id = state.next_id.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let (tx, mut rx) = unbounded_channel::<Message>();
    state
        .senders
        .lock()
        .map_err(|error| error.to_string())?
        .insert(id, tx);

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
        if let Ok(mut senders) = state.senders.lock() {
            senders.remove(&id);
        }
        return Err("WebSocket event channel is already closed".to_string());
    }

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
                        return;
                    }
                }
                Ok(Message::Binary(bytes)) => {
                    let data = String::from_utf8_lossy(&bytes).to_string();
                    if on_event
                        .send(json!({ "type": "message", "data": data }))
                        .is_err()
                    {
                        return;
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
                    let pong = app
                        .state::<BridgeState>()
                        .senders
                        .lock()
                        .ok()
                        .and_then(|senders| senders.get(&id).cloned());
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
        if let Ok(mut senders) = app.state::<BridgeState>().senders.lock() {
            senders.remove(&id);
        }
    });

    Ok(id)
}

#[tauri::command]
pub fn ws_bridge_send(state: State<'_, BridgeState>, id: u32, data: String) -> Result<(), String> {
    let senders = state.senders.lock().map_err(|error| error.to_string())?;
    let sender = senders
        .get(&id)
        .ok_or_else(|| "WebSocket is not connected".to_string())?;
    sender
        .send(Message::Text(data.into()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ws_bridge_close(
    state: State<'_, BridgeState>,
    id: u32,
    code: Option<u16>,
    reason: Option<String>,
) -> Result<(), String> {
    let sender = state
        .senders
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id);
    if let Some(sender) = sender {
        let frame = code.map(|code| CloseFrame {
            code: code.into(),
            reason: reason.unwrap_or_default().into(),
        });
        let _ = sender.send(Message::Close(frame));
    }
    Ok(())
}
