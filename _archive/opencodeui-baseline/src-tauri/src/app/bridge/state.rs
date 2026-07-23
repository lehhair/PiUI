use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use tokio::sync::mpsc::UnboundedSender;

/// Command sent from the frontend to an active WebSocket bridge.
#[derive(Debug)]
pub enum BridgeCommand {
    Send(String),
    Close,
}

/// A single active bridge connection.
pub struct BridgeConnection {
    pub id: u64,
    /// `Some` for WebSocket connections (bidirectional),
    /// `None` for HTTP stream connections (read-only, cancelled via id mismatch).
    pub tx: Option<UnboundedSender<BridgeCommand>>,
}

impl BridgeConnection {
    pub fn new_ws(id: u64, tx: UnboundedSender<BridgeCommand>) -> Self {
        Self { id, tx: Some(tx) }
    }

    pub fn new_stream(id: u64) -> Self {
        Self { id, tx: None }
    }
}

/// Composite key: (window label, bridge id).
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct BridgeKey {
    window_label: String,
    bridge_id: String,
}

impl BridgeKey {
    pub fn new(window_label: &str, bridge_id: &str) -> Self {
        Self {
            window_label: window_label.to_string(),
            bridge_id: bridge_id.to_string(),
        }
    }

    pub fn window_label(&self) -> &str {
        &self.window_label
    }
}

/// Global bridge state shared across all windows.
#[derive(Default)]
pub struct BridgeState {
    next_id: AtomicU64,
    active: Mutex<HashMap<BridgeKey, BridgeConnection>>,
}

impl BridgeState {
    /// Allocate the next connection id.
    pub fn next_conn_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Insert a new connection, returning the previous one (if any) so
    /// the caller can shut it down.
    pub fn replace(&self, key: BridgeKey, conn: BridgeConnection) -> Option<BridgeConnection> {
        self.active
            .lock()
            .expect("bridge state poisoned")
            .insert(key, conn)
    }

    /// Get the sender for a WebSocket connection.
    pub fn sender(&self, key: &BridgeKey) -> Option<UnboundedSender<BridgeCommand>> {
        self.active
            .lock()
            .expect("bridge state poisoned")
            .get(key)
            .and_then(|conn| conn.tx.clone())
    }

    /// Remove the connection only if its id matches (prevents a new
    /// connection from being removed by an old task's cleanup).
    pub fn remove_if_current(&self, key: &BridgeKey, id: u64) {
        let mut guard = self.active.lock().expect("bridge state poisoned");
        if guard.get(key).is_some_and(|conn| conn.id == id) {
            guard.remove(key);
        }
    }

    /// Gracefully disconnect a specific bridge.
    pub fn disconnect(&self, key: &BridgeKey) -> bool {
        let removed = self
            .active
            .lock()
            .expect("bridge state poisoned")
            .remove(key);
        if let Some(conn) = removed {
            if let Some(tx) = conn.tx {
                let _ = tx.send(BridgeCommand::Close);
            }
            return true;
        }
        false
    }

    /// Disconnect all bridges belonging to a window (called on window destroy).
    pub fn disconnect_window(&self, window_label: &str) {
        let removed = {
            let mut guard = self.active.lock().expect("bridge state poisoned");
            let keys: Vec<_> = guard
                .keys()
                .filter(|k| k.window_label() == window_label)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|k| guard.remove(&k))
                .collect::<Vec<_>>()
        };

        for conn in removed {
            if let Some(tx) = conn.tx {
                let _ = tx.send(BridgeCommand::Close);
            }
        }
    }

    /// Check whether a connection id is still current (used by HTTP
    /// stream loops to detect cancellation).
    pub fn is_current(&self, key: &BridgeKey, id: u64) -> bool {
        self.active
            .lock()
            .expect("bridge state poisoned")
            .get(key)
            .is_some_and(|conn| conn.id == id)
    }
}
