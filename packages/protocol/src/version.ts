export const PROTOCOL_VERSION = 1 as const
export type ProtocolVersion = typeof PROTOCOL_VERSION

export const PI_PARITY_SDK_VERSION = "0.81.1" as const

export const DEFAULT_HTTP_BASE = "http://127.0.0.1:8787"
export const DEFAULT_HOST_WS_URL = "ws://127.0.0.1:8787"
export const EVENT_WS_SUBPROTOCOL = "piui.events.v1"
