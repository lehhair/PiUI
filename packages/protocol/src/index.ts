/** PiUI browser ↔ server protocol v1 */

import type { ProtocolHandshakeV2 } from "./handshake-v2.js"

export const PROTOCOL_VERSION = 1 as const
export type ProtocolVersion = typeof PROTOCOL_VERSION

export const DEFAULT_HOST_WS_URL = "ws://127.0.0.1:8787"
export const DEFAULT_HTTP_BASE = "http://127.0.0.1:8787"

export * from "./errors.js"
export * from "./workspace.js"
export * from "./events.js"
export * from "./session.js"
export * from "./git.js"
export * from "./command.js"
export * from "./capabilities-v2.js"
export * from "./events-v2.js"
export * from "./extension-ui.js"
export * from "./management.js"
export * from "./handshake-v2.js"
export * from "./commands-v2.js"

export interface HealthResponseV1 {
  ok: true
  protocolVersion: ProtocolVersion
  service: "piui-server"
  phase: number
  protocolV2?: ProtocolHandshakeV2
}
