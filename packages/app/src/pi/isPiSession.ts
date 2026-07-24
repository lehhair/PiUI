import { sessionProjectionStore } from "./sessionProjectionStore"

/** True when this session is backed by Pi projection (not OpenCode). */
export function isPiSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  return sessionProjectionStore.getSnapshot()?.session.id === sessionId
}
