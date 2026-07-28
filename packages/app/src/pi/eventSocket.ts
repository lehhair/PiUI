import {
  EVENT_WS_SUBPROTOCOL_V2,
  eventStreamKeyV2,
  parseEventStreamKeyV2,
  type AnyEventEnvelopeV2,
  type EventCursorMapV2,
  type EventCursorV2,
  type EventEnvelopeV1,
  type EventServerMessageV2,
  type EventStreamRefV2,
  type SessionSnapshotV1,
} from "@piui/protocol"
import {
  getApiBase,
  getPiAuthToken,
  fetchExtensionUiSnapshot,
  setExtensionEditorState,
  resetWorkspaceResolutionCache,
} from "./sessionApi"
import {
  applyPiNativeEventToUi,
  applySnapshotToUi,
  resyncPiSessionToUi,
} from "./applySnapshot"
import {
  listTrackedPiSessions,
  listTrackedPiWorkspacePaths,
  subscribePiSessionIndex,
  trackPiSession,
} from "./piSessionIndex"
import { nativeSessionStore } from "./nativeSessionStore"
import { extensionUiStore } from "./extensionUiStore"
import { configureSessionEditorDraftSync, setSessionEditorDraft } from "./sessionEditorDraftStore"
import { notificationStore } from "../store/notificationStore"
import { invalidateWorkspaceFileCaches } from "../api/file"
import { notifyReconnected, notifySessionIdle } from "../hooks/useGlobalEvents"
import { reportPiConnectionState } from "../api/events"
import {
  getTrackedManagementProviders,
  receivePackageProgress,
  receiveProviderAuthEvent,
  receiveProviderAuthUpdated,
  receiveResourceRevision,
  subscribeManagementStreams,
} from "./managementEventStore"

type Status = "idle" | "connecting" | "open" | "closed"

function wsUrl(cursor?: { epoch: string; sequence: number }): string {
  const base = getApiBase()
  const token = getPiAuthToken()
  const params = new URLSearchParams()
  if (token) params.set("token", token)
  if (cursor) {
    params.set("cursorEpoch", cursor.epoch)
    params.set("cursorSequence", String(cursor.sequence))
  }
  const suffix = params.size ? `?${params.toString()}` : ""
  if (!base) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    return `${proto}//${window.location.host}/api/v1/events${suffix}`
  }
  return base.replace(/^http/, "ws") + "/api/v1/events" + suffix
}

export class PiEventSocket {
  private ws: WebSocket | null = null
  private status: Status = "idle"
  private statusListeners = new Set<(status: Status) => void>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastPongAt = 0
  private intentionalClose = false
  private legacyEpoch: string | null = null
  private legacySequence = 0
  private legacyBlocked = false
  private legacyResync: Promise<void> | null = null
  private cursorsV2: EventCursorMapV2 = {}
  private blockedStreamsV2 = new Set<string>()
  private resyncingStreamsV2 = new Map<string, Promise<void>>()
  private replayRequestedStreamsV2 = new Set<string>()
  private unsubscribeSessionIndex: (() => void) | null = null
  private unsubscribeManagementStreams: (() => void) | null = null
  private openedBefore = false

  getStatus() {
    return this.status
  }

  onStatus(listener: (status: Status) => void): () => void {
    this.statusListeners.add(listener)
    listener(this.status)
    return () => this.statusListeners.delete(listener)
  }

  private setStatus(status: Status) {
    this.status = status
    reportPiConnectionState(
      status === "open" ? "connected" : status === "connecting" ? "connecting" : "disconnected",
      { lastEventTime: status === "open" ? Date.now() : undefined },
    )
    for (const listener of this.statusListeners) listener(status)
  }

  connect() {
    if (typeof window === "undefined") return
    if (this.ws && (this.status === "open" || this.status === "connecting")) return
    this.intentionalClose = false
    this.setStatus("connecting")
    this.unsubscribeSessionIndex ??= subscribePiSessionIndex(() => this.sendV2Subscription())
    this.unsubscribeManagementStreams ??= subscribeManagementStreams(() => this.sendV2Subscription())
    configureSessionEditorDraftSync((sessionId, text) => {
      if (!listTrackedPiSessions().includes(sessionId)) return
      return setExtensionEditorState(sessionId, text).then(snapshot => extensionUiStore.replace(snapshot))
    })
    try {
      const legacyCursor = this.legacyEpoch
        ? { epoch: this.legacyEpoch, sequence: this.legacySequence }
        : undefined
      const ws = new WebSocket(wsUrl(legacyCursor), EVENT_WS_SUBPROTOCOL_V2)
      this.ws = ws
      ws.onopen = () => {
        this.setStatus("open")
        this.lastPongAt = Date.now()
        this.startHeartbeat()
        if (this.openedBefore) {
          resetWorkspaceResolutionCache()
          notifyReconnected()
        }
        this.sendV2Subscription()
        this.openedBefore = true
      }
      ws.onclose = () => {
        this.stopHeartbeat()
        this.replayRequestedStreamsV2.clear()
        this.ws = null
        this.setStatus("closed")
        if (!this.intentionalClose) this.scheduleReconnect()
      }
      ws.onerror = () => this.setStatus("closed")
      ws.onmessage = event => this.handleMessage(String(event.data))
    } catch {
      this.setStatus("closed")
      this.scheduleReconnect()
    }
  }

  private handleMessage(raw: string): void {
    try {
      const message = JSON.parse(raw) as {
        channel?: string
        event?: EventEnvelopeV1 | AnyEventEnvelopeV2
        type?: string
        protocolVersion?: number
        cursor?: { epoch: string; sequence: number }
        streams?: Extract<EventServerMessageV2, { type: "resync_required" }>["streams"]
      }
      if (message.type === "pong") {
        this.lastPongAt = Date.now()
        return
      }
      if (message.channel === "event" && message.event?.protocolVersion === 2) {
        this.handleEventV2(message.event)
        return
      }
      if (message.channel === "event" && message.event?.protocolVersion === 1) {
        this.handleLegacyEvent(message.event)
        return
      }
      if (message.channel === "control" && message.type === "resync_required" && message.streams) {
        void Promise.all(Object.entries(message.streams).map(([key, state]) =>
          state ? this.resyncStreamV2(key, state.cursor) : Promise.resolve(),
        )).then(() => this.sendV2Subscription()).catch(() => this.ws?.close())
        return
      }
      if (message.channel === "control" && message.type === "resync_required") {
        void this.resyncLegacySnapshots().then(() => {
          if (!message.cursor) return
          this.legacyEpoch = message.cursor.epoch
          this.legacySequence = message.cursor.sequence
          this.legacyBlocked = false
        })
      }
    } catch {
      /* ignore malformed messages */
    }
  }

  private handleEventV2(event: AnyEventEnvelopeV2): void {
    const key = eventStreamKeyV2(event.stream)
    const cursor = this.cursorsV2[key]
    if (this.blockedStreamsV2.has(key)) return
    if (!cursor || cursor.epoch !== event.cursor.epoch || event.cursor.sequence > cursor.sequence + 1) {
      if (this.replayRequestedStreamsV2.has(key)) return
      this.replayRequestedStreamsV2.add(key)
      this.sendV2Subscription()
      return
    }
    if (event.cursor.sequence <= cursor.sequence) return
    this.replayRequestedStreamsV2.delete(key)

    if (event.type === "session.snapshot.updated") {
      const snapshot = event.payload.snapshot
      if (snapshot.session.id !== event.payload.sessionId || snapshot.session.id !== event.stream.id) return
      trackPiSession(snapshot.session.id, snapshot.session.directory)
      applySnapshotToUi(snapshot, { activate: false })
      if (snapshot.session.state === "idle") notifySessionIdle(snapshot.session.id)
    } else if (event.type === "session.native.event") {
      if (event.payload.sessionId !== event.stream.id) return
      applyPiNativeEventToUi(event.payload.sessionId, event.payload.event, event.payload.meta)
    } else if (event.type === "session.runtime.replaced" || event.type === "session.runtime.crashed") {
      this.blockedStreamsV2.add(key)
      void this.resyncStreamV2(key, event.cursor)
      return
    } else if (event.type === "workspace.sessions.updated") {
      window.dispatchEvent(new CustomEvent("piui:sessions-changed"))
    } else if (event.type === "workspace.files.changed") {
      if (event.payload.workspacePath !== event.stream.id) return
      invalidateWorkspaceFileCaches(event.payload.workspacePath)
      window.dispatchEvent(new CustomEvent("piui:workspace-files-changed", { detail: event.payload }))
    } else if (event.type === "workspace.git.updated") {
      if (event.payload.workspacePath !== event.stream.id) return
      window.dispatchEvent(new CustomEvent("piui:workspace-git-updated", { detail: event.payload }))
    } else if (event.type === "extension.ui.requested") {
      extensionUiStore.requestOpened(event.payload)
    } else if (event.type === "extension.ui.settled") {
      extensionUiStore.requestSettled(event.payload.sessionId, event.payload.requestId)
    } else if (event.type === "extension.ui.cancelled") {
      extensionUiStore.requestSettled(event.stream.id, event.payload.requestId)
    } else if (event.type === "extension.ui.state.updated") {
      extensionUiStore.stateUpdated(event.payload.sessionId, event.payload.state)
    } else if (event.type === "extension.ui.editor.command") {
      extensionUiStore.editorCommand(event.payload.sessionId, event.payload.command)
      const editorText = extensionUiStore.getSnapshot().sessions[event.payload.sessionId]?.state.editorText ?? ""
      setSessionEditorDraft(event.payload.sessionId, editorText, { sync: false })
    } else if (event.type === "extension.ui.notified") {
      notificationStore.push(
        event.payload.notifyType === "error" ? "error" : "completed",
        "Extension",
        event.payload.message,
        event.payload.sessionId,
      )
    } else if (event.type === "provider.auth.flow") {
      receiveProviderAuthEvent(event.payload, event.stream.kind === "session" ? event.stream.id : undefined)
    } else if (event.type === "provider.auth.updated") {
      receiveProviderAuthUpdated()
      window.dispatchEvent(new CustomEvent("piui:provider-auth-updated", { detail: event.payload }))
    } else if (event.type === "packages.progress") {
      receivePackageProgress(event.payload)
    } else if (event.type === "resources.updated") {
      receiveResourceRevision(event.payload.workspacePath, event.payload.revision)
      window.dispatchEvent(new CustomEvent("piui:resources-updated", { detail: event.payload }))
    } else if (
      event.type === "command.updated" &&
      event.payload.sessionId &&
      (event.payload.status === "failed" ||
        event.payload.status === "cancelled" ||
        event.payload.status === "unknown_after_crash")
    ) {
      window.dispatchEvent(new CustomEvent("piui:command-updated", { detail: event.payload }))
      void resyncPiSessionToUi(event.payload.sessionId, { activate: false })
        .catch(() => undefined)
    } else if (event.type === "command.updated") {
      window.dispatchEvent(new CustomEvent("piui:command-updated", { detail: event.payload }))
    }
    this.cursorsV2[key] = event.cursor
  }

  private handleLegacyEvent(event: EventEnvelopeV1): void {
    if (this.legacyBlocked) return
    if (!this.legacyEpoch) {
      this.legacyEpoch = event.epoch
      this.legacySequence = Math.max(0, event.sequence - 1)
    } else if (this.legacyEpoch !== event.epoch) {
      this.legacyBlocked = true
      void this.resyncLegacySnapshots().then(() => {
        this.legacyEpoch = event.epoch
        this.legacySequence = event.sequence
        this.legacyBlocked = false
      })
      return
    }
    if (event.sequence <= this.legacySequence) return
    if (this.legacySequence > 0 && event.sequence > this.legacySequence + 1) {
      this.legacyBlocked = true
      void this.resyncLegacySnapshots().then(() => {
        this.legacySequence = event.sequence
        this.legacyBlocked = false
      })
      return
    }
    this.legacySequence = event.sequence
    if (event.type === "session.snapshot" && event.payload) {
      const snapshot = event.payload as SessionSnapshotV1
      if (snapshot.session?.id && (!event.sessionId || event.sessionId === snapshot.session.id)) {
        trackPiSession(snapshot.session.id, snapshot.session.directory)
        applySnapshotToUi(snapshot, { activate: false })
      }
    } else if (event.type === "session.updated") {
      window.dispatchEvent(new CustomEvent("piui:sessions-changed"))
    }
  }

  private currentStreamsV2(): EventStreamRefV2[] {
    const ids = new Set([...listTrackedPiSessions(), ...nativeSessionStore.getSessionIds()])
    const workspaces = listTrackedPiWorkspacePaths().map(path => ({ kind: "workspace" as const, id: path }))
    const resources = listTrackedPiWorkspacePaths().map(path => ({ kind: "resources" as const, id: path }))
    const providers = getTrackedManagementProviders().map(id => ({ kind: "provider" as const, id }))
    const sessionLimit = Math.max(0, 255 - workspaces.length - resources.length - providers.length)
    const sessions = [...ids].slice(-sessionLimit).map(id => ({ kind: "session" as const, id }))
    return [{ kind: "server", id: "server" }, ...workspaces, ...resources, ...providers, ...sessions]
  }

  private sendV2Subscription(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.ws.protocol !== EVENT_WS_SUBPROTOCOL_V2) return
    this.ws.send(JSON.stringify({
      type: "subscribe",
      protocolVersion: 2,
      streams: this.currentStreamsV2(),
      cursors: this.cursorsV2,
    }))
  }

  private resyncStreamV2(key: string, cursor: EventCursorV2): Promise<void> {
    const stream = parseEventStreamKeyV2(key)
    if (!stream) return Promise.resolve()
    const streamKey = eventStreamKeyV2(stream)
    const existing = this.resyncingStreamsV2.get(streamKey)
    if (existing) return existing
    this.blockedStreamsV2.add(streamKey)

    const pending = (async () => {
      if (stream.kind === "session") {
        await resyncPiSessionToUi(stream.id, { activate: false })
        try {
          extensionUiStore.replace(await fetchExtensionUiSnapshot(stream.id))
        } catch {
          extensionUiStore.remove(stream.id)
        }
      } else if (stream.kind === "server" || stream.kind === "workspace") {
        window.dispatchEvent(new CustomEvent("piui:sessions-changed"))
        if (stream.kind === "workspace") {
          invalidateWorkspaceFileCaches(stream.id)
          window.dispatchEvent(new CustomEvent("piui:workspace-files-changed", {
            detail: { workspacePath: stream.id, revision: cursor.sequence, changes: [], rescan: true },
          }))
          window.dispatchEvent(new CustomEvent("piui:workspace-git-updated", {
            detail: { workspacePath: stream.id, revision: cursor.sequence },
          }))
        }
      } else if (stream.kind === "resources") {
        receiveResourceRevision(stream.id, String(cursor.sequence))
      }
      this.cursorsV2[streamKey] = cursor
      this.blockedStreamsV2.delete(streamKey)
      this.replayRequestedStreamsV2.delete(streamKey)
    })().catch(() => {
      this.ws?.close()
    }).finally(() => {
      this.resyncingStreamsV2.delete(streamKey)
    })
    this.resyncingStreamsV2.set(streamKey, pending)
    return pending
  }

  private resyncLegacySnapshots(): Promise<void> {
    if (this.legacyResync) return this.legacyResync
    const ids = new Set([...listTrackedPiSessions(), ...nativeSessionStore.getSessionIds()])
    this.legacyResync = Promise.all([...ids].map(async id => {
      try {
        await resyncPiSessionToUi(id, { activate: false })
      } catch {
        /* deleted sessions disappear on the next session-list refresh */
      }
    })).then(() => undefined).finally(() => {
      this.legacyResync = null
    })
    return this.legacyResync
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 1500)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastPongAt > 45_000) {
        ws.close()
        return
      }
      ws.send(JSON.stringify({ type: "ping", protocolVersion: 2 }))
    }, 15_000)
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  close() {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.unsubscribeSessionIndex?.()
    this.unsubscribeSessionIndex = null
    this.unsubscribeManagementStreams?.()
    this.unsubscribeManagementStreams = null
    configureSessionEditorDraftSync(undefined)
    this.stopHeartbeat()
    this.ws?.close()
    this.ws = null
    this.setStatus("closed")
  }
}

let singleton: PiEventSocket | null = null

export function getPiEventSocket(): PiEventSocket {
  if (!singleton) singleton = new PiEventSocket()
  return singleton
}

export function ensurePiEventSocket(): PiEventSocket {
  const socket = getPiEventSocket()
  socket.connect()
  return socket
}

export function resetPiEventSocket(): PiEventSocket {
  singleton?.close()
  singleton = new PiEventSocket()
  singleton.connect()
  return singleton
}
