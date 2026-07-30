import {
  PROTOCOL_VERSION,
  eventStreamKey,
  type EventCursor,
  type EventCursorMap,
  type EventEnvelope,
  type EventServerMessage,
  type EventStreamRef,
} from '@piui/protocol'
import type { AgentMessage, AgentSessionEvent, PiLiveMessage } from './domain/index.js'
import type { SessionsActivitySnapshot, SessionActivityStatus } from '@piui/protocol'
import { getApiBase } from './sessionApi.js'
import { piBranchStore } from './state/index.js'
import { activeSessionStore } from '../store/activeSessionStore'
import type { SessionStatus } from '../types/session'
import {
  loadPiSessionData,
  loadPiSessions,
  refreshPiBranch,
  refreshPiSessionState,
} from './controllers/index.js'

const PING_INTERVAL_MS = 25_000
const RECONNECT_DELAY_MS = 1_000
const REFRESH_DEBOUNCE_MS = 150

type PiEventPayload = {
  event: AgentSessionEvent
  meta: EventCursor & { liveMessage?: { id: string; revision: number } }
}

/**
 * WebSocket event stream client for /api/v1/events (multi-session).
 *
 * Panes connect/disconnect sessions with reference counting; the socket
 * resubscribes the full active set on every change (server subscribe is
 * replace-semantics). Events route to the owning session's keyed stores:
 * - message_update: update checkpoint.liveMessage locally (no request)
 * - entry/turn/agent events: debounced branch refresh (latest page merge)
 * - state-only events: debounced state.get refresh
 * - resync_required: full reload for that stream
 * - sessions.updated: reload global session list
 */
class PiEventStream {
  private ws: WebSocket | null = null
  private refCounts = new Map<string, number>()
  private cursors = new Map<string, EventCursor>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private branchRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private stateRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** Subscribe a session stream (reference counted). */
  connect(sessionId: string): void {
    this.refCounts.set(sessionId, (this.refCounts.get(sessionId) ?? 0) + 1)
    if (this.refCounts.get(sessionId) === 1) {
      this.ensureSocket()
      if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe()
    }
  }

  /** Unsubscribe a session stream; closes the socket when nothing remains. */
  disconnect(sessionId: string): void {
    const count = this.refCounts.get(sessionId) ?? 0
    if (count <= 1) {
      this.refCounts.delete(sessionId)
      this.cursors.delete(sessionId)
    } else {
      this.refCounts.set(sessionId, count - 1)
      return
    }
    if (this.refCounts.size === 0) {
      this.closeSocket()
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe()
    }
  }

  /** Drop everything (server switch etc.). */
  disconnectAll(): void {
    this.refCounts.clear()
    this.cursors.clear()
    this.closeSocket()
  }

  private ensureSocket(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) return
    this.openSocket()
  }

  private closeSocket(): void {
    const ws = this.ws
    this.ws = null
    this.clearPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      ws.close()
    }
  }

  private openSocket(): void {
    const url = new URL(wsEventsUrl())
    const token = (import.meta as ImportMeta & { env?: { VITE_PIUI_TOKEN?: string } }).env?.VITE_PIUI_TOKEN
    if (token) url.searchParams.set('token', token)

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.sendSubscribe()
      this.pingTimer = setInterval(() => {
        this.send({ type: 'ping', protocolVersion: PROTOCOL_VERSION })
      }, PING_INTERVAL_MS)
    }
    ws.onmessage = e => this.handleRaw(String(e.data))
    ws.onclose = () => {
      this.clearPing()
      if (this.ws === ws) this.ws = null
      if (this.refCounts.size > 0) {
        this.reconnectTimer = setTimeout(() => this.openSocket(), RECONNECT_DELAY_MS)
      }
    }
    ws.onerror = () => {
      // close follows; reconnect handled there
    }
  }

  private sendSubscribe(): void {
    const streams: EventStreamRef[] = [{ kind: 'server', id: 'server' }]
    const cursors: EventCursorMap = {}
    for (const sessionId of this.refCounts.keys()) {
      streams.push({ kind: 'session', id: sessionId })
      const cursor = this.cursors.get(sessionId) ?? piBranchStore.getData(sessionId)?.checkpoint?.position
      if (cursor) cursors[eventStreamKey({ kind: 'session', id: sessionId })] = cursor
    }
    this.send({ type: 'subscribe', protocolVersion: PROTOCOL_VERSION, streams, cursors })
  }

  private send(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  private handleRaw(raw: string): void {
    let message: EventServerMessage
    try {
      message = JSON.parse(raw) as EventServerMessage
    } catch {
      return
    }
    if ('channel' in message && message.channel === 'event') {
      this.handleEvent(message.event)
      return
    }
    if ('channel' in message && message.channel === 'control' && message.type === 'resync_required') {
      for (const key of Object.keys(message.streams)) {
        const match = /^session:(.+)$/.exec(key)
        if (match) this.handleResync(decodeURIComponent(match[1]))
      }
      return
    }
  }

  private handleEvent(envelope: EventEnvelope): void {
    const sessionId = envelope.stream.kind === 'session' ? envelope.stream.id : null
    if (sessionId) this.cursors.set(sessionId, envelope.cursor)
    switch (envelope.channel) {
      case 'pi.event':
        if (sessionId) this.handlePiEvent(sessionId, envelope.payload as unknown as PiEventPayload)
        break
      case 'session.head':
        if (sessionId) this.scheduleBranchRefresh(sessionId)
        break
      case 'sessions.updated':
        void loadPiSessions().catch(() => undefined)
        break
      case 'sessions.activity':
        this.handleActivitySnapshot(envelope.payload as unknown as SessionsActivitySnapshot)
        break
    }
  }

  /**
   * Global session activity (worker-derived from SDK isStreaming/isRetrying).
   * Feeds activeSessionStore so the sidebar shows working/retrying dots.
   */
  private handleActivitySnapshot(snapshot: SessionsActivitySnapshot): void {
    const active = snapshot?.sessions ?? {}
    for (const [sessionId, status] of Object.entries(active)) {
      activeSessionStore.updateStatus(sessionId, activityToSessionStatus(status))
    }
    // Sessions no longer active -> idle (clears their dot)
    for (const sessionId of this.knownActiveSessions) {
      if (!(sessionId in active)) activeSessionStore.updateStatus(sessionId, { type: 'idle' })
    }
    this.knownActiveSessions = new Set(Object.keys(active))
  }

  private knownActiveSessions = new Set<string>()

  private handlePiEvent(sessionId: string, payload: PiEventPayload): void {
    const { event, meta } = payload
    switch (event.type) {
      case 'message_start':
      case 'message_update':
        this.updateLiveMessage(sessionId, event.message, meta)
        break
      case 'message_end':
      case 'turn_end':
      case 'entry_appended':
      case 'tool_execution_end':
        this.scheduleBranchRefresh(sessionId)
        break
      case 'agent_end':
      case 'agent_settled':
        this.scheduleBranchRefresh(sessionId)
        this.scheduleStateRefresh(sessionId)
        break
      case 'agent_start':
      case 'turn_start':
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'thinking_level_changed':
      case 'session_info_changed':
      case 'queue_update':
      case 'compaction_start':
      case 'compaction_end':
      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
        this.scheduleStateRefresh(sessionId)
        break
    }
  }

  private updateLiveMessage(sessionId: string, message: AgentMessage, meta: PiEventPayload['meta']): void {
    const data = piBranchStore.getData(sessionId)
    if (!data?.checkpoint) return
    const liveMessage: PiLiveMessage = {
      id: meta.liveMessage?.id ?? `live-${meta.sequence}`,
      revision: meta.liveMessage?.revision ?? meta.sequence,
      phase: 'streaming',
      message,
    }
    piBranchStore.setData(sessionId, { ...data, checkpoint: { ...data.checkpoint, liveMessage } })
  }

  private handleResync(sessionId: string): void {
    this.cursors.delete(sessionId)
    void loadPiSessionData(sessionId).catch(() => undefined)
  }

  private scheduleBranchRefresh(sessionId: string): void {
    if (this.branchRefreshTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.branchRefreshTimers.delete(sessionId)
      void refreshPiBranch(sessionId).catch(() => undefined)
    }, REFRESH_DEBOUNCE_MS)
    this.branchRefreshTimers.set(sessionId, timer)
  }

  private scheduleStateRefresh(sessionId: string): void {
    if (this.stateRefreshTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.stateRefreshTimers.delete(sessionId)
      void refreshPiSessionState(sessionId).catch(() => undefined)
    }, REFRESH_DEBOUNCE_MS)
    this.stateRefreshTimers.set(sessionId, timer)
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }
}

export const piEventStream = new PiEventStream()

function activityToSessionStatus(status: SessionActivityStatus): SessionStatus {
  if (status.type === 'retry') {
    return { type: 'retry', attempt: status.attempt, message: status.message, next: status.next }
  }
  return { type: 'busy' }
}

function wsEventsUrl(): string {
  const base = getApiBase()
  if (base) return base.replace(/^http/, 'ws') + '/api/v1/events'
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}/api/v1/events`
}
