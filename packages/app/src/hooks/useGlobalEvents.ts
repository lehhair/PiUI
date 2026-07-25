import { useEffect } from 'react'

/**
 * PiUI keeps the pane-consumer contract while Pi permission/question events
 * are not implemented. Session streaming is delivered by PiEventSocket.
 */
export interface SessionEventCallbacks {
  onPermissionAsked?: (request: unknown) => void
  onPermissionReplied?: (data: { sessionID: string; requestID: string }) => void
  onQuestionAsked?: (request: unknown) => void
  onQuestionReplied?: (data: { sessionID: string; requestID: string }) => void
  onQuestionRejected?: (data: { sessionID: string; requestID: string }) => void
  onScrollRequest?: () => void
  onSessionIdle?: (sessionID: string) => void
  onSessionError?: (sessionID: string) => void
  onReconnected?: (reason: 'network' | 'server-switch') => void
}

interface SessionConsumer {
  sessionId: string | null
  callbacks: SessionEventCallbacks
}

const sessionConsumers = new Map<string, SessionConsumer>()

export function registerSessionConsumer(
  consumerId: string,
  sessionId: string | null,
  callbacks: SessionEventCallbacks,
): () => void {
  sessionConsumers.set(consumerId, { sessionId, callbacks })
  return () => sessionConsumers.delete(consumerId)
}

export function updateConsumerSessionId(consumerId: string, sessionId: string | null) {
  const consumer = sessionConsumers.get(consumerId)
  if (consumer) consumer.sessionId = sessionId
}

export function hasOtherConsumerForSession(sessionId: string, consumerId: string): boolean {
  for (const [id, consumer] of sessionConsumers) {
    if (id !== consumerId && consumer.sessionId === sessionId) return true
  }
  return false
}

/** Pi session events are subscribed through pi/eventSocket, not legacy SSE. */
export function useGlobalEvents(_directories?: string[]) {
  useEffect(() => undefined, [])
}
