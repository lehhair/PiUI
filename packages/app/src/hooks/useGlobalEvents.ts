import { useEffect, useRef } from 'react'
import type { PermissionRequest, QuestionRequest } from '../types/api/permission'
import i18n from '../i18n'
import { useFocusedSessionId } from '../pi/hooks/index.js'
import { activeSessionStore } from '../store/activeSessionStore'
import { notificationStore } from '../store/notificationStore'
import { notificationEventSettingsStore } from '../store/notificationEventSettingsStore'
import { useNotification } from './useNotification'

/**
 * PiUI keeps the pane-consumer contract while Pi permission/question events
 * are not implemented. Session streaming is delivered by PiEventSocket.
 */
export interface SessionEventCallbacks {
  onPermissionAsked?: (request: PermissionRequest) => void
  onPermissionReplied?: (data: { sessionID: string; requestID: string }) => void
  onQuestionAsked?: (request: QuestionRequest) => void
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
const sessionIdleListeners = new Set<(sessionId: string) => void>()
const notifiedIdleSessions = new Set<string>()

export function registerSessionConsumer(
  consumerId: string,
  sessionId: string | null,
  callbacks: SessionEventCallbacks,
): () => void {
  sessionConsumers.set(consumerId, { sessionId, callbacks })
  return () => sessionConsumers.delete(consumerId)
}

export function notifySessionIdle(sessionId: string): void {
  for (const consumer of sessionConsumers.values()) {
    if (consumer.sessionId === sessionId) consumer.callbacks.onSessionIdle?.(sessionId)
  }
  if (notifiedIdleSessions.has(sessionId)) return
  notifiedIdleSessions.add(sessionId)
  sessionIdleListeners.forEach(listener => listener(sessionId))
}

export function notifySessionStarted(sessionId: string): void {
  notifiedIdleSessions.delete(sessionId)
}

export function subscribeSessionIdle(listener: (sessionId: string) => void): () => void {
  sessionIdleListeners.add(listener)
  return () => sessionIdleListeners.delete(listener)
}

export function notifyReconnected(): void {
  for (const consumer of sessionConsumers.values()) consumer.callbacks.onReconnected?.('network')
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
  const focusedSessionId = useFocusedSessionId()
  const focusedSessionIdRef = useRef(focusedSessionId)
  focusedSessionIdRef.current = focusedSessionId
  const { sendNotification } = useNotification()

  useEffect(() => {
    return subscribeSessionIdle(sessionId => {
      // The open pane already shows the completed response. Notifications are
      // for sessions that finished while the user was looking elsewhere.
      if (sessionId === focusedSessionIdRef.current) return

      const meta = activeSessionStore.getSessionMeta(sessionId)
      const title = meta?.title || sessionId.slice(0, 12)
      const body = i18n.t('chat:notification.completed')
      notificationStore.push('completed', title, body, sessionId, meta?.directory)

      if (notificationEventSettingsStore.isSystemEnabled('completed')) {
        void sendNotification(title, body, { sessionId, directory: meta?.directory })
      }
    })
  }, [sendNotification])
}
