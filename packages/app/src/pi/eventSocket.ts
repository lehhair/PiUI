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
import { getApiBase, getPiAuthToken, fetchSnapshot } from "./sessionApi"
import { applySnapshotToUi } from "./applySnapshot"
import {
  listTrackedPiSessions,
  listTrackedPiWorkspaces,
  subscribePiSessionIndex,
  trackPiSession,
} from "./piSessionIndex"
import { sessionProjectionStore } from "./sessionProjectionStore"

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
  private intentionalClose = false
  private legacyEpoch: string | null = null
  private legacySequence = 0
  private legacyBlocked = false
  private legacyResync: Promise<void> | null = null
  private cursorsV2: EventCursorMapV2 = {}
  private blockedStreamsV2 = new Set<string>()
  private resyncingStreamsV2 = new Map<string, Promise<void>>()
  private unsubscribeSessionIndex: (() => void) | null = null

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
    for (const listener of this.statusListeners) listener(status)
  }

  connect() {
    if (typeof window === "undefined") return
    if (this.ws && (this.status === "open" || this.status === "connecting")) return
    this.intentionalClose = false
    this.setStatus("connecting")
    this.unsubscribeSessionIndex ??= subscribePiSessionIndex(() => this.sendV2Subscription())
    try {
      const legacyCursor = this.legacyEpoch
        ? { epoch: this.legacyEpoch, sequence: this.legacySequence }
        : undefined
      const ws = new WebSocket(wsUrl(legacyCursor), EVENT_WS_SUBPROTOCOL_V2)
      this.ws = ws
      ws.onopen = () => {
        this.setStatus("open")
        this.sendV2Subscription()
      }
      ws.onclose = () => {
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
      if (message.channel === "event" && message.event?.protocolVersion === 2) {
        this.handleEventV2(message.event)
        return
      }
      if (message.channel === "event" && message.event?.protocolVersion === 1) {
        this.handleLegacyEvent(message.event)
        return
      }
      if (message.channel === "control" && message.type === "resync_required" && message.streams) {
        for (const [key, state] of Object.entries(message.streams)) {
          if (state) void this.resyncStreamV2(key, state.cursor)
        }
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
    if (this.blockedStreamsV2.has(key)) return
    const cursor = this.cursorsV2[key]
    if (!cursor || cursor.epoch !== event.cursor.epoch || event.cursor.sequence > cursor.sequence + 1) {
      this.blockedStreamsV2.add(key)
      this.sendV2Subscription([event.stream])
      return
    }
    if (event.cursor.sequence <= cursor.sequence) return

    if (event.type === "session.snapshot.updated") {
      const snapshot = event.payload.snapshot
      if (snapshot.session.id !== event.payload.sessionId || snapshot.session.id !== event.stream.id) return
      trackPiSession(snapshot.session.id, snapshot.session.workspaceId)
      applySnapshotToUi(snapshot, { activate: false })
    } else if (event.type === "session.timeline.delta") {
      if (event.payload.sessionId !== event.stream.id) return
      const snapshot = sessionProjectionStore.buildTimelineDelta(
        event.payload.sessionId,
        event.payload.epoch,
        event.payload.sequence,
        event.payload.items,
        event.payload.removedItemIds,
        event.payload.isStreaming,
      )
      if (!snapshot) {
        this.blockedStreamsV2.add(key)
        void this.resyncStreamV2(key, event.cursor)
        return
      }
      applySnapshotToUi(snapshot, { activate: false })
    } else if (event.type === "session.runtime.replaced" || event.type === "session.runtime.crashed") {
      this.blockedStreamsV2.add(key)
      void this.resyncStreamV2(key, event.cursor)
      return
    } else if (event.type === "workspace.sessions.updated") {
      window.dispatchEvent(new CustomEvent("piui:sessions-changed"))
    } else if (
      event.type === "command.updated" &&
      event.payload.sessionId &&
      (event.payload.status === "failed" ||
        event.payload.status === "cancelled" ||
        event.payload.status === "unknown_after_crash")
    ) {
      window.dispatchEvent(new CustomEvent("piui:command-updated", { detail: event.payload }))
      void fetchSnapshot(event.payload.sessionId)
        .then(snapshot => applySnapshotToUi(snapshot, { activate: false }))
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
        trackPiSession(snapshot.session.id, snapshot.session.workspaceId)
        applySnapshotToUi(snapshot, { activate: false })
      }
    } else if (event.type === "session.updated") {
      window.dispatchEvent(new CustomEvent("piui:sessions-changed"))
    }
  }

  private currentStreamsV2(): EventStreamRefV2[] {
    const ids = new Set([...listTrackedPiSessions(), ...sessionProjectionStore.getSessionIds()])
    return [
      { kind: "server", id: "server" },
      ...listTrackedPiWorkspaces().map(id => ({ kind: "workspace" as const, id })),
      ...[...ids].map(id => ({ kind: "session" as const, id })),
    ]
  }

  private sendV2Subscription(streams = this.currentStreamsV2()): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.ws.protocol !== EVENT_WS_SUBPROTOCOL_V2) return
    this.ws.send(JSON.stringify({
      type: "subscribe",
      protocolVersion: 2,
      streams,
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
        applySnapshotToUi(await fetchSnapshot(stream.id), { activate: false })
      } else if (stream.kind === "server" || stream.kind === "workspace") {
        window.dispatchEvent(new CustomEvent("piui:sessions-changed"))
      }
      this.cursorsV2[streamKey] = cursor
      this.blockedStreamsV2.delete(streamKey)
      this.sendV2Subscription([stream])
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
    const ids = new Set([...listTrackedPiSessions(), ...sessionProjectionStore.getSessionIds()])
    this.legacyResync = Promise.all([...ids].map(async id => {
      try {
        applySnapshotToUi(await fetchSnapshot(id), { activate: false })
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
      void import("./serverMode").then(({ isPiServerReachable }) => {
        if (isPiServerReachable()) this.connect()
      })
    }, 1500)
  }

  close() {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.unsubscribeSessionIndex?.()
    this.unsubscribeSessionIndex = null
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
