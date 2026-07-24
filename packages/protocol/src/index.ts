/** PiUI browser ↔ server protocol v1 */

export const PROTOCOL_VERSION = 1 as const
export type ProtocolVersion = typeof PROTOCOL_VERSION

export const DEFAULT_HOST_WS_URL = "ws://127.0.0.1:8787"
export const DEFAULT_HTTP_BASE = "http://127.0.0.1:8787"

export * from "./errors.js"
export * from "./workspace.js"
export * from "./events.js"

export interface HealthResponseV1 {
  ok: true
  protocolVersion: ProtocolVersion
  service: "piui-server"
  phase: number
}
