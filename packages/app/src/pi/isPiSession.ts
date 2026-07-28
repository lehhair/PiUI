import { nativeSessionStore } from "./nativeSessionStore"
import { isTrackedPiSession } from "./piSessionIndex"
import { isPiServerReachable, setPiServerReachable } from "./serverMode"

export { isPiServerReachable, setPiServerReachable }

/** True when this session is backed by Pi (tracked or currently loaded). */
export function isPiSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  if (isTrackedPiSession(sessionId)) return true
  return nativeSessionStore.getSnapshot(sessionId) !== null
}

/** Prefer Pi chat path whenever server is up (even before a session exists). */
export function shouldUsePiChat(sessionId?: string | null): boolean {
  if (isPiServerReachable()) return true
  return isPiSession(sessionId)
}
