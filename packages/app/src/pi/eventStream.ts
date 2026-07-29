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
import { getApiBase } from './sessionApi.js'
import { piBranchStore } from './state/index.js'
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
 * WebSocket event stream client for /api/v1/events.
 *
 * Subscribes to the active session stream plus the server stream and
 * keeps the raw stores fresh:
 * - message_update: update checkpoint.liveMessage locally (no request)
 * - entry/turn/agent events: debounced branch refresh (latest page merge)
 * - state-only events: debounced state.get refresh
 * - resync_required: full reload (cursors no longer valid)
 * - sessions.updated: reload global session list
 */
class PiEventStream {
  private ws: WebSocket | null = null
  private sessionId: string | null = null
  private lastCursor: EventCursor | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private branchRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private stateRefreshTimer: ReturnType<typeof setTimeout> | null = null

  connect(sessionId: string): void {
    if (this.sessionId === sessionId && this.ws) return
    this.disconnect()
    this.sessionId = sessionId
    this.openSocket()
  }

  disconnect(): void {
    const ws = this.ws
    this.sessionId = null
    this.ws = null
    this.lastCursor = null
    this.clearTimers()
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      ws.close()
    }
  }

  private openSocket(): void {
    const sessionId = this.sessionId
    if (!sessionId) return

    const url = new URL(wsEventsUrl())
    const token = (import.meta as ImportMeta & { env?: { VITE_PIUI_TOKEN?: string } }).env?.VITE_PIUI_TOKEN
    if (token) url.searchParams.set('token', token)

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.sendSubscribe(sessionId)
      this.pingTimer = setInterval(() => {
        this.send({ type: 'ping', protocolVersion: PROTOCOL_VERSION })
      }, PING_INTERVAL_MS)
    }
    ws.onmessage = e => this.handleRaw(String(e.data))
    ws.onclose = () => {
      this.clearPing()
      if (this.ws === ws) this.ws = null
      if (this.sessionId) {
        this.reconnectTimer = setTimeout(() => this.openSocket(), RECONNECT_DELAY_MS)
      }
    }
    ws.onerror = () => {
      // close follows; reconnect handled there
    }
  }

  private sendSubscribe(sessionId: string): void {
    const streams: EventStreamRef[] = [
      { kind: 'session', id: sessionId },
      { kind: 'server', id: 'server' },
    ]
    const cursors: EventCursorMap = {}
    const sessionCursor = this.lastCursor ?? piBranchStore.getData()?.checkpoint?.position
    if (sessionCursor) {
      cursors[eventStreamKey({ kind: 'session', id: sessionId })] = sessionCursor
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
      this.handleResync()
      return
    }
  }

  private handleEvent(envelope: EventEnvelope): void {
    this.lastCursor = envelope.cursor
    switch (envelope.channel) {
      case 'pi.event':
        this.handlePiEvent(envelope.payload as unknown as PiEventPayload)
        break
      case 'session.head':
        this.scheduleBranchRefresh()
        break
      case 'sessions.updated':
        void loadPiSessions().catch(() => undefined)
        break
    }
  }

  private handlePiEvent(payload: PiEventPayload): void {
    const { event, meta } = payload
    switch (event.type) {
      case 'message_start':
      case 'message_update':
        this.updateLiveMessage(event.message, meta)
        break
      case 'message_end':
      case 'turn_end':
      case 'entry_appended':
      case 'tool_execution_end':
        this.scheduleBranchRefresh()
        break
      case 'agent_end':
      case 'agent_settled':
        this.scheduleBranchRefresh()
        this.scheduleStateRefresh()
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
        this.scheduleStateRefresh()
        break
    }
  }

  private updateLiveMessage(message: AgentMessage, meta: PiEventPayload['meta']): void {
    const data = piBranchStore.getData()
    if (!data?.checkpoint) return
    const liveMessage: PiLiveMessage = {
      id: meta.liveMessage?.id ?? `live-${meta.sequence}`,
      revision: meta.liveMessage?.revision ?? meta.sequence,
      phase: 'streaming',
      message,
    }
    piBranchStore.setData({ ...data, checkpoint: { ...data.checkpoint, liveMessage } })
  }

  private handleResync(): void {
    this.lastCursor = null
    const sessionId = this.sessionId
    if (!sessionId) return
    void loadPiSessionData(sessionId).catch(() => undefined)
  }

  private scheduleBranchRefresh(): void {
    if (this.branchRefreshTimer) return
    this.branchRefreshTimer = setTimeout(() => {
      this.branchRefreshTimer = null
      const sessionId = this.sessionId
      if (sessionId) void refreshPiBranch(sessionId).catch(() => undefined)
    }, REFRESH_DEBOUNCE_MS)
  }

  private scheduleStateRefresh(): void {
    if (this.stateRefreshTimer) return
    this.stateRefreshTimer = setTimeout(() => {
      this.stateRefreshTimer = null
      const sessionId = this.sessionId
      if (sessionId) void refreshPiSessionState(sessionId).catch(() => undefined)
    }, REFRESH_DEBOUNCE_MS)
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private clearTimers(): void {
    this.clearPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.branchRefreshTimer) {
      clearTimeout(this.branchRefreshTimer)
      this.branchRefreshTimer = null
    }
    if (this.stateRefreshTimer) {
      clearTimeout(this.stateRefreshTimer)
      this.stateRefreshTimer = null
    }
  }
}

export const piEventStream = new PiEventStream()

function wsEventsUrl(): string {
  const base = getApiBase()
  if (base) return base.replace(/^http/, 'ws') + '/api/v1/events'
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}/api/v1/events`
}
