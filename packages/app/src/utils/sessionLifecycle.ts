import { activeSessionStore } from '../store/activeSessionStore'
import { piBranchStore, piSessionStateStore } from '../pi/state/index.js'
import { piEventStream } from '../pi/eventStream'

export function clearSessionRuntimeState(sessionId: string) {
  piEventStream.disconnect(sessionId)
  piBranchStore.clear(sessionId)
  piSessionStateStore.clear(sessionId)
  activeSessionStore.removeSession(sessionId)
}
