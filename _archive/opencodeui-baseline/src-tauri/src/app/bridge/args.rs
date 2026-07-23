use serde::Deserialize;

/// Arguments for `bridge_connect`.
///
/// `bridge_id` is an opaque label chosen by the frontend (e.g. `"sse"`,
/// a PTY id, etc.). Together with the window label it forms the unique
/// connection key.
///
/// The Rust layer inspects the URL scheme to pick the transport:
///   - `ws://` / `wss://`  → WebSocket (bidirectional)
///   - `http://` / `https://` → HTTP streaming (read-only)
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    bridge_id: String,
    url: String,
    auth_header: Option<String>,
}

impl ConnectArgs {
    #[inline(always)]
    pub fn bridge_id(&self) -> &str {
        &self.bridge_id
    }

    #[inline(always)]
    pub fn url(&self) -> &str {
        &self.url
    }

    #[inline(always)]
    pub fn auth_header(&self) -> Option<&str> {
        self.auth_header.as_deref()
    }

    /// Returns `true` when the URL uses WebSocket scheme.
    pub fn is_websocket(&self) -> bool {
        self.url.starts_with("ws://") || self.url.starts_with("wss://")
    }
}

/// Arguments for `bridge_send` (WebSocket only).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendArgs {
    bridge_id: String,
    data: String,
}

impl SendArgs {
    #[inline(always)]
    pub fn bridge_id(&self) -> &str {
        &self.bridge_id
    }

    #[inline(always)]
    pub fn data(&self) -> &str {
        &self.data
    }
}

/// Arguments for `bridge_disconnect`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectArgs {
    bridge_id: String,
}

impl DisconnectArgs {
    #[inline(always)]
    pub fn bridge_id(&self) -> &str {
        &self.bridge_id
    }
}
