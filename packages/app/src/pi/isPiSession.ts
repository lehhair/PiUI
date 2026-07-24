import { sessionProjectionStore } from "./sessionProjectionStore"
import { isTrackedPiSession } from "./piSessionIndex"

/** True when this session is backed by Pi (tracked or current projection). */
export function isPiSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  if (isTrackedPiSession(sessionId)) return true
  return sessionProjectionStore.getSnapshot()?.session.id === sessionId
}

/** Cached: is piui-server reachable (updated by bootstrap / health). */
let _piServerUp = false

export function setPiServerReachable(up: boolean) {
  _piServerUp = up
}

export function isPiServerReachable(): boolean {
  return _piServerUp
}

/** Prefer Pi chat path whenever server is up (even before a session exists). */
export function shouldUsePiChat(sessionId?: string | null): boolean {
  if (_piServerUp) return true
  return isPiSession(sessionId)
}
