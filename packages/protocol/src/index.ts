/** PiUI browser ↔ server protocol (v1 skeleton). Full schema in later phases. */

export const PROTOCOL_VERSION = 1 as const

export const DEFAULT_HOST_WS_URL = "ws://127.0.0.1:8787"
export const DEFAULT_HTTP_BASE = "http://127.0.0.1:8787"

export type ProtocolVersion = typeof PROTOCOL_VERSION
