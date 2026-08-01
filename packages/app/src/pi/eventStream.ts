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
import type { ProviderAuthEvent, SessionsActivitySnapshot, SessionActivityStatus } from '@piui/protocol'
import { getApiBase, getPiAuthToken } from './httpClient.js'
import { piBranchStore, piSessionStateStore } from './state/index.js'
import { extensionUiStore } from './extensionUiStore'
import { activeSessionStore } from '../store/activeSessionStore'
import {
  getTrackedManagementProviders,
  receivePackageProgress,
  receiveProviderAuthEvent,
  receiveProviderAuthUpdated,
  receiveResourceRevision,
  subscribeManagementStreams,
  type PackageProgress,
} from './managementEventStore'
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

type PiExtensionUiEvent =
  | { type: 'requested'; request: import('@piui/protocol').ExtensionUiDialogRequest }
  | { type: 'settled'; requestId: string; sessionId: string }
  | { type: 'state'; sessionId: string; patch: import('@piui/protocol').ExtensionUiStatePatch }
  | { type: 'notify'; sessionId: string; message: string; notifyType?: 'info' | 'warning' | 'error' }
  | { type: 'editor'; sessionId: string; command: import('@piui/protocol').ExtensionUiEditorCommand }

type SessionsUpdatedPayload = {
  sessionId?: string
  attached?: boolean
  detached?: boolean
  replaced?: boolean
  sourceSessionId?: string
  targetSessionId?: string
  targetCwd?: string
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
  constructor() {
    queueMicrotask(() => this.ensureManagementWatch())
  }

  private ws: WebSocket | null = null
  private refCounts = new Map<string, number>()
  private cursors = new Map<string, EventCursor>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private branchRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private stateRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** True when a stream is currently subscribed (refCount > 0). */
  isSubscribed(sessionId: string): boolean {
    return (this.refCounts.get(sessionId) ?? 0) > 0
  }

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
      this.clearRefreshTimers(sessionId)
    } else {
      this.refCounts.set(sessionId, count - 1)
      return
    }
    if (this.refCounts.size === 0 && getTrackedManagementProviders().length === 0) {
      this.closeSocket()
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe()
    }
  }

  private managementWatched = false

  /**
   * Keep provider streams (auth flows) subscribed whenever providers are
   * tracked, even with no session connected — the socket stays up for them.
   */
  private ensureManagementWatch(): void {
    if (this.managementWatched) return
    this.managementWatched = true
    subscribeManagementStreams(() => {
      if (getTrackedManagementProviders().length > 0) {
        this.ensureSocket()
        if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe()
      } else if (this.refCounts.size === 0) {
        this.closeSocket()
      }
    })
  }

  /** Drop everything (server switch etc.). */
  disconnectAll(): void {
    for (const sessionId of this.refCounts.keys()) this.clearRefreshTimers(sessionId)
    this.refCounts.clear()
    this.cursors.clear()
    this.closeSocket()
  }

  private clearRefreshTimers(sessionId: string): void {
    const branchTimer = this.branchRefreshTimers.get(sessionId)
    if (branchTimer) {
      clearTimeout(branchTimer)
      this.branchRefreshTimers.delete(sessionId)
    }
    const stateTimer = this.stateRefreshTimers.get(sessionId)
    if (stateTimer) {
      clearTimeout(stateTimer)
      this.stateRefreshTimers.delete(sessionId)
    }
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
    const token = getPiAuthToken()
    if (token) url.searchParams.set('token', token)

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.sendSubscribe()
      this.pingTimer = setInterval(() => {
        this.send({ type: 'ping', protocolVersion: PROTOCOL_VERSION })
      }, PING_INTERVAL_MS)
    }
    ws.onmessage = e => {
      // A stale socket may still deliver buffered frames after closeSocket()
      // swapped this.ws (server switch). Ignore messages from any socket that
      // is no longer the active one, mirroring the onclose identity check.
      if (this.ws !== ws) return
      this.handleRaw(String(e.data))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.clearPing()
      this.ws = null
      if (this.refCounts.size > 0 || getTrackedManagementProviders().length > 0) {
        if (this.reconnectTimer) return
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          if (!this.ws) this.openSocket()
        }, RECONNECT_DELAY_MS)
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
    for (const providerId of getTrackedManagementProviders()) {
      streams.push({ kind: 'provider', id: providerId })
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
        this.handleSessionsUpdated(envelope.payload as SessionsUpdatedPayload | undefined)
        break
      case 'sessions.activity':
        this.handleActivitySnapshot(envelope.payload as unknown as SessionsActivitySnapshot)
        break
      case 'extension.ui':
        if (sessionId) this.handleExtensionUiEvent(sessionId, envelope.payload as unknown as PiExtensionUiEvent)
        break
      case 'provider.auth':
        this.handleProviderAuthEvent(envelope.payload as unknown as ProviderAuthEvent)
        break
      case 'packages.progress':
        receivePackageProgress(envelope.payload as unknown as PackageProgress)
        break
      case 'resources.updated': {
        const payload = envelope.payload as { workspacePath?: string | null } | undefined
        receiveResourceRevision(payload?.workspacePath ?? undefined, String(envelope.cursor.sequence))
        break
      }
    }
  }

  private handleProviderAuthEvent(event: ProviderAuthEvent): void {
    receiveProviderAuthEvent(event)
    // Terminal auth states change providers.list — bump listeners to refetch
    if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
      receiveProviderAuthUpdated()
    }
  }

  private handleSessionsUpdated(payload: SessionsUpdatedPayload | undefined): void {
    if (payload?.replaced && payload.sourceSessionId && payload.targetSessionId) {
      // Runtime replacement (fork/new/import): the worker now owns a
      // different session id. Drop the old session's cursors and keyed
      // data; panes re-subscribe and reload under the new id when they
      // follow piui:session-replaced (their connect effect owns ref counts).
      this.cursors.delete(payload.sourceSessionId)
      this.branchRefreshTimers.delete(payload.sourceSessionId)
      this.stateRefreshTimers.delete(payload.sourceSessionId)
      piBranchStore.clear(payload.sourceSessionId)
      piSessionStateStore.clear(payload.sourceSessionId)
      window.dispatchEvent(new CustomEvent('piui:session-replaced', { detail: payload }))
    }
    void loadPiSessions().catch(() => undefined)
    window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
  }

  private handleExtensionUiEvent(sessionId: string, event: PiExtensionUiEvent): void {
    switch (event.type) {
      case 'requested':
        extensionUiStore.requestOpened(event.request)
        // Surface as pending action on the sidebar (awaiting permission/answer)
        activeSessionStore.addPendingRequest(
          event.request.requestId,
          sessionId,
          event.request.kind === 'confirm' ? 'permission' : 'question',
          event.request.title,
        )
        break
      case 'settled':
        extensionUiStore.requestSettled(sessionId, event.requestId)
        activeSessionStore.resolvePendingRequest(event.requestId)
        break
      case 'state':
        extensionUiStore.statePatched(sessionId, event.patch)
        break
      case 'editor':
        extensionUiStore.editorCommand(sessionId, event.command)
        break
      case 'notify':
        // Notifications surface through the extension UI state/status
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
