use serde::Serialize;

/// Unified bridge event pushed to the frontend via Tauri Channel.
///
/// The Rust layer is a transparent proxy — `data` is forwarded as-is
/// without parsing or field renaming. The frontend decides how to
/// interpret it (SSE line parsing, terminal output, etc.).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum BridgeEvent {
    Connected,
    Data { data: String },
    Disconnected { code: Option<u16>, reason: String },
    Error { message: String },
}
