import { sessionProjectionStore } from "./sessionProjectionStore"
import { isTrackedPiSession } from "./piSessionIndex"
import { isPiServerReachable, setPiServerReachable } from "./serverMode"

export { isPiServerReachable, setPiServerReachable }

/** True when this session is backed by Pi (tracked or current projection). */
export function isPiSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  if (isTrackedPiSession(sessionId)) return true
  return sessionProjectionStore.getSnapshot()?.session.id === sessionId
}

/** Prefer Pi chat path whenever server is up (even before a session exists). */
export function shouldUsePiChat(sessionId?: string | null): boolean {
  if (isPiServerReachable()) return true
  return isPiSession(sessionId)
}
