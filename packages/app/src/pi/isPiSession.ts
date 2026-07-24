import { sessionProjectionStore } from "./sessionProjectionStore"
import { isTrackedPiSession } from "./piSessionIndex"

/** True when this session is backed by Pi (tracked or current projection). */
export function isPiSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  if (isTrackedPiSession(sessionId)) return true
  return sessionProjectionStore.getSnapshot()?.session.id === sessionId
}
