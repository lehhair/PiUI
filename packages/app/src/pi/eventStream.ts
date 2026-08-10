import {
  PROTOCOL_VERSION,
  eventStreamKey,
  parseEventStreamKey,
  type EventCursor,
  type EventCursorMap,
  type EventEnvelope,
  type EventServerMessage,
  type EventStreamKey,
  type EventStreamRef,
  isJsonObject,
  type CommandRecord,
} from '@piui/protocol'
import type { AgentMessage, AgentSessionEvent, PiLiveMessage } from './domain/index.js'
import type { ProviderAuthEvent, SessionsActivitySnapshot, SessionActivityStatus } from '@piui/protocol'
import { getApiBase, getPiAuthToken } from './httpClient.js'
import { openPiSocket, PI_SOCKET_CLOSED, PI_SOCKET_CLOSING, PI_SOCKET_OPEN, type PiSocket } from './piSocket'
import { piBranchStore, piCommandStore, piSessionStateStore } from './state/index.js'
import { extensionUiStore } from './extensionUiStore'
import { extensionTuiStore } from './extensionTuiStore'
import { commandFeedbackStore } from './commandFeedbackStore'
import { notificationStore } from '../store/notificationStore'
import { liveToolOutputStore, extractToolExecutionText } from './liveToolOutput'
import { activeSessionStore } from '../store/activeSessionStore'
import { serverStore } from '../store/serverStore'
import { perfMark } from '../utils/perf'
import { notifyReconnected, notifySessionIdle, notifySessionStarted } from '../hooks/useGlobalEvents'
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
  | { type: 'tuiAttach'; sessionId: string; attach: import('@piui/protocol').ExtensionTuiAttach }
  | { type: 'tuiDetach'; sessionId: string; key: string }
  | { type: 'tuiFrame'; sessionId: string; data: string }

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

  private ws: PiSocket | null = null
  private refCounts = new Map<string, number>()
  private workspaceRefCounts = new Map<string, number>()
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
      if (this.ws?.readyState === PI_SOCKET_OPEN) this.sendSubscribe()
    }
  }

  /** Unsubscribe a session stream; closes the socket when nothing remains. */
  disconnect(sessionId: string): void {
    const count = this.refCounts.get(sessionId) ?? 0
    if (count <= 1) {
      this.refCounts.delete(sessionId)
      this.cursors.delete(eventStreamKey({ kind: 'session', id: sessionId }))
      this.clearRefreshTimers(sessionId)
      liveToolOutputStore.clearSession(sessionId)
    } else {
      this.refCounts.set(sessionId, count - 1)
      return
    }
    if (!this.hasSubscriptions()) {
      this.closeSocket()
    } else if (this.ws?.readyState === PI_SOCKET_OPEN) {
      this.sendSubscribe()
    }
  }

  connectWorkspace(workspacePath: string): void {
    const count = (this.workspaceRefCounts.get(workspacePath) ?? 0) + 1
    this.workspaceRefCounts.set(workspacePath, count)
    if (count === 1) {
      this.ensureSocket()
      if (this.ws?.readyState === PI_SOCKET_OPEN) this.sendSubscribe()
    }
  }

  disconnectWorkspace(workspacePath: string): void {
    const count = this.workspaceRefCounts.get(workspacePath) ?? 0
    if (count <= 1) this.workspaceRefCounts.delete(workspacePath)
    else this.workspaceRefCounts.set(workspacePath, count - 1)
    if (!this.hasSubscriptions()) this.closeSocket()
    else if (this.ws?.readyState === PI_SOCKET_OPEN) this.sendSubscribe()
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
        if (this.ws?.readyState === PI_SOCKET_OPEN) this.sendSubscribe()
      } else if (!this.hasSubscriptions()) {
        this.closeSocket()
      }
    })
  }

  /** Drop everything (server switch etc.). */
  disconnectAll(): void {
    for (const sessionId of this.refCounts.keys()) this.clearRefreshTimers(sessionId)
    this.refCounts.clear()
    this.workspaceRefCounts.clear()
    this.cursors.clear()
    piCommandStore.clearAll()
    this.closeSocket()
  }

  /** Replace every subscription when the active backend changes. */
  handleServerChange(): void {
    this.disconnectAll()
    if (getTrackedManagementProviders().length > 0) {
      this.ensureSocket()
      if (this.ws?.readyState === PI_SOCKET_OPEN) this.sendSubscribe()
    }
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
    if (this.ws && this.ws.readyState !== PI_SOCKET_CLOSED && this.ws.readyState !== PI_SOCKET_CLOSING) return
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
    if (ws && ws.readyState !== PI_SOCKET_CLOSED && ws.readyState !== PI_SOCKET_CLOSING) {
      ws.close()
    }
  }

  private openSocket(): void {
    const url = new URL(wsEventsUrl())
    const token = getPiAuthToken()
    if (token) url.searchParams.set('token', token)

    const ws = openPiSocket(url.toString())
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.sendSubscribe()
      notifyReconnected()
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
      if (this.hasSubscriptions()) {
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
    const serverCursor = this.cursors.get('server')
    if (serverCursor) cursors.server = serverCursor
    for (const sessionId of this.refCounts.keys()) {
      const stream = { kind: 'session' as const, id: sessionId }
      streams.push(stream)
      const key = eventStreamKey(stream)
      const cursor = this.cursors.get(key)
      if (cursor) cursors[key] = cursor
    }
    for (const workspacePath of this.workspaceRefCounts.keys()) {
      const stream = { kind: 'workspace' as const, id: workspacePath }
      streams.push(stream)
      const key = eventStreamKey(stream)
      const cursor = this.cursors.get(key)
      if (cursor) cursors[key] = cursor
    }
    for (const providerId of getTrackedManagementProviders()) {
      const stream = { kind: 'provider' as const, id: providerId }
      streams.push(stream)
      const cursor = this.cursors.get(eventStreamKey(stream))
      if (cursor) cursors[eventStreamKey(stream)] = cursor
    }
    this.send({ type: 'subscribe', protocolVersion: PROTOCOL_VERSION, streams, cursors })

    // 主动把订阅中 session 的运行时 state 拿回来：页面刷新 / ws 重连后
    // state store 是空的，而它只依赖“新事件到达后被动拉取” —— 活跃中的
    // worker 不推新事件（等待权限 / 单条消息在队列里）时 isStreaming、队列、
    // 上下文用量永远不恢复。每次订阅建立都主动 pull 一次（有防抖合并），
    // 让打开/刷新会话时立即拿到正在工作的 runtime 的真实状态。
    for (const sessionId of this.refCounts.keys()) {
      this.scheduleStateRefresh(sessionId)
    }
  }

  private send(message: unknown): void {
    if (this.ws?.readyState === PI_SOCKET_OPEN) {
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
        this.handleResync(key, message.streams[key as EventStreamKey]?.cursor)
      }
      return
    }
    if ('channel' in message && message.channel === 'control' && message.type === 'problem') {
      this.closeSocket()
      window.dispatchEvent(new CustomEvent('piui:event-stream-error', { detail: message.problem }))
    }
  }

  private handleEvent(envelope: EventEnvelope): void {
    const sessionId = envelope.stream.kind === 'session' ? envelope.stream.id : null
    this.cursors.set(eventStreamKey(envelope.stream), envelope.cursor)
    switch (envelope.channel) {
      case 'pi.event':
        if (sessionId) this.handlePiEvent(sessionId, envelope.payload as unknown as PiEventPayload)
        break
      case 'session.head':
        // head 移动 = 树形（undo/redo/导航）变化：branch（时间线）和
        // state（leafId/指纹）都过期了。state 不刷的话会话树面板和
        // redo 计划都感知不到别处的导航，双向联动就断了
        if (sessionId) {
          this.scheduleBranchRefresh(sessionId)
          this.scheduleStateRefresh(sessionId)
        }
        break
      case 'sessions.updated':
        this.handleSessionsUpdated(envelope.payload as SessionsUpdatedPayload | undefined)
        break
      case 'sessions.activity':
        this.handleActivitySnapshot(envelope.payload as unknown as SessionsActivitySnapshot)
        break
      case 'command.updated':
        if (isCommandRecord(envelope.payload)) {
          piCommandStore.upsert(envelope.payload)
          window.dispatchEvent(new CustomEvent('piui:command-updated', { detail: envelope.payload }))
        }
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
      case 'workspace.files':
        window.dispatchEvent(new CustomEvent('piui:workspace-files-changed', { detail: envelope.payload }))
        break
      case 'workspace.git':
        window.dispatchEvent(new CustomEvent('piui:workspace-git-updated', { detail: envelope.payload }))
        break
      case 'registry.updated': {
        const payload = envelope.payload as { sessionId?: string } | undefined
        if (sessionId || payload?.sessionId) {
          window.dispatchEvent(new CustomEvent('piui:registry-updated', {
            detail: { sessionId: sessionId ?? payload?.sessionId },
          }))
        }
        break
      }
      case 'terminal.created':
      case 'terminal.updated':
      case 'terminal.exited':
      case 'terminal.deleted':
        window.dispatchEvent(new CustomEvent('piui:terminals-changed', {
          detail: { workspacePath: envelope.stream.kind === 'workspace' ? envelope.stream.id : undefined },
        }))
        break
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
      this.cursors.delete(eventStreamKey({ kind: 'session', id: payload.sourceSessionId }))
      this.branchRefreshTimers.delete(payload.sourceSessionId)
      this.stateRefreshTimers.delete(payload.sourceSessionId)
      piBranchStore.clear(payload.sourceSessionId)
      piSessionStateStore.clear(payload.sourceSessionId)
      piCommandStore.clearSession(payload.sourceSessionId)
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
      case 'notify': {
        // 扩展通知（ctx.ui.notify）是扩展命令的主要输出通道（如 /perm list 的
        // 规则列表）。完整文本进命令反馈日志；同时弹一条瞬时通知。
        const status = event.notifyType === 'error' ? 'error' : event.notifyType === 'warning' ? 'info' : 'ok'
        commandFeedbackStore.add({
          sessionId,
          command: '',
          kind: 'notify',
          status,
          message: event.message,
        })
        notificationStore.push(
          event.notifyType === 'error' ? 'error' : 'completed',
          'Extension',
          event.message,
          sessionId,
        )
        break
      }
      case 'tuiAttach':
        extensionTuiStore.attach(event.sessionId, event.attach)
        break
      case 'tuiDetach':
        extensionTuiStore.detach(event.sessionId, event.key)
        break
      case 'tuiFrame':
        extensionTuiStore.frame(event.sessionId, event.data)
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
      if (!this.knownActiveSessions.has(sessionId)) notifySessionStarted(sessionId)
      activeSessionStore.updateStatus(sessionId, activityToSessionStatus(status))
    }
    // Sessions no longer active -> idle (clears their dot)
    for (const sessionId of this.knownActiveSessions) {
      if (!(sessionId in active)) {
        activeSessionStore.updateStatus(sessionId, { type: 'idle' })
        notifySessionIdle(sessionId)
      }
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
        this.scheduleBranchRefresh(sessionId)
        break
      case 'tool_execution_end':
        if ('toolCallId' in event && typeof event.toolCallId === 'string') {
          liveToolOutputStore.delete(event.toolCallId)
        }
        this.scheduleBranchRefresh(sessionId)
        break
      case 'tool_execution_update': {
        if ('toolCallId' in event && typeof event.toolCallId === 'string') {
          const text = extractToolExecutionText('partialResult' in event ? event.partialResult : undefined)
          if (text) liveToolOutputStore.set(event.toolCallId, sessionId, text)
        }
        this.scheduleStateRefresh(sessionId)
        break
      }
      case 'bash_execution_update': {
        // 用户 `!cmd`/`/bash` 的流式输出（pi TUI onChunk 的事件流对应物）。
        // id = worker 透传的 clientId，delta 是增量 chunk。
        if ('id' in event && typeof event.id === 'string' && event.id
          && 'delta' in event && typeof event.delta === 'string') {
          liveToolOutputStore.append(event.id, sessionId, event.delta)
        }
        this.scheduleStateRefresh(sessionId)
        break
      }
      case 'agent_end':
      case 'agent_settled':
        this.scheduleBranchRefresh(sessionId)
        this.scheduleStateRefresh(sessionId)
        notifySessionIdle(sessionId)
        break
      case 'agent_start':
        notifySessionStarted(sessionId)
        this.scheduleStateRefresh(sessionId)
        break
      case 'turn_start':
      case 'thinking_level_changed':
      case 'session_info_changed':
      case 'queue_update':
      case 'compaction_start':
      case 'compaction_end':
        this.scheduleStateRefresh(sessionId)
        // 压缩结束会改写会话（插入 compaction 摘要条目）：强制刷新分支，
        // 让"上下文已压缩"分隔线出现在聊天流里，而不是等不可靠的
        // entry_appended 事件。
        if (event.type === 'compaction_end') this.scheduleBranchRefresh(sessionId)
        break
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
    perfMark('piui:event-message-update')
    const data = piBranchStore.getData(sessionId)
    if (!data) return
    const liveMessage: PiLiveMessage = {
      id: meta.liveMessage?.id ?? `live-${meta.sequence}`,
      revision: meta.liveMessage?.revision ?? meta.sequence,
      phase: 'streaming',
      message,
    }
    // checkpoint 可能不存在（fresh 会话本地构造的 page / preview 未带
    // checkpoint）：此时仍要保留 liveMessage，否则流式内容被丢弃，要等
    // message_end 后 branch refresh 才整体出现。position 用 head 兜底。
    const checkpoint = data.checkpoint
      ? { ...data.checkpoint, liveMessage }
      : { position: { epoch: data.head.epoch, sequence: data.head.revision }, liveMessage }
    piBranchStore.setData(sessionId, { ...data, checkpoint })
  }

  private handleResync(key: string, cursor?: EventCursor): void {
    const stream = parseEventStreamKey(key)
    if (!stream) return
    if (cursor) this.cursors.set(key, cursor)
    if (stream.kind === 'session') {
      void loadPiSessionData(stream.id).catch(() => undefined)
      // resync 时同样主动拉一次运行时 state（branch 与 state 一起恢复）
      this.scheduleStateRefresh(stream.id)
    } else if (stream.kind === 'server') {
      void loadPiSessions().catch(() => undefined)
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
    } else if (stream.kind === 'provider') {
      receiveProviderAuthUpdated()
    } else if (stream.kind === 'workspace') {
      window.dispatchEvent(new CustomEvent('piui:workspace-files-changed', {
        detail: { workspacePath: stream.id, changes: [], rescan: true },
      }))
      window.dispatchEvent(new CustomEvent('piui:workspace-git-updated', {
        detail: { workspacePath: stream.id },
      }))
    }
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

  private hasSubscriptions(): boolean {
    return this.refCounts.size > 0 || this.workspaceRefCounts.size > 0 || getTrackedManagementProviders().length > 0
  }
}

export const piEventStream = new PiEventStream()
serverStore.onServerChange(() => piEventStream.handleServerChange())

function isCommandRecord(value: unknown): value is CommandRecord {
  if (!isJsonObject(value)) return false
  return typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    (value.status === 'accepted' || value.status === 'running' || value.status === 'completed' ||
      value.status === 'failed' || value.status === 'cancelled' || value.status === 'unknown_after_crash') &&
    typeof value.submittedAt === 'string'
}

function activityToSessionStatus(status: SessionActivityStatus): SessionStatus {
  if (status.type === 'retry') {
    return { type: 'retry', attempt: status.attempt, message: status.message, next: status.next }
  }
  // compacting 保留独立类型（信息流指示/停止按钮靠它驱动），busy 算工作中
  if (status.type === 'compacting') {
    return { type: 'compacting' }
  }
  return { type: 'busy' }
}

function wsEventsUrl(): string {
  const base = getApiBase()
  if (base) return base.replace(/^http/, 'ws') + '/api/v1/events'
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}/api/v1/events`
}
