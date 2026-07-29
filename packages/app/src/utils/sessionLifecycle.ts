import { activeSessionStore } from '../store/activeSessionStore'
import { followupQueueStore } from '../store/followupQueueStore'
import { messageStore } from '../store/messageStore'
import { todoStore } from '../store/todoStore'

export function clearSessionRuntimeState(sessionId: string) {
  messageStore.clearSession(sessionId)
  followupQueueStore.clearSession(sessionId)
  todoStore.clearTodos(sessionId)
  activeSessionStore.removeSession(sessionId)
}
