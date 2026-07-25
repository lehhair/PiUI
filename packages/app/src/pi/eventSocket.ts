import type { EventEnvelopeV1, SessionSnapshotV1 } from "@piui/protocol"
import { getApiBase, getPiAuthToken } from "./sessionApi"
import { applySnapshotToUi } from "./applySnapshot"
import { listTrackedPiSessions, trackPiSession } from "./piSessionIndex"
import { fetchSnapshot } from "./sessionApi"
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
  private statusListeners = new Set<(s: Status) => void>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  private epoch: string | null = null
  private sequence = 0
  private resyncing: Promise<void> | null = null

  getStatus() {
    return this.status
  }

  onStatus(listener: (s: Status) => void): () => void {
    this.statusListeners.add(listener)
    listener(this.status)
    return () => this.statusListeners.delete(listener)
  }

  private setStatus(s: Status) {
    this.status = s
    for (const l of this.statusListeners) l(s)
  }

  connect() {
    if (typeof window === "undefined") return
    if (this.ws && (this.status === "open" || this.status === "connecting")) return
    this.intentionalClose = false
    this.setStatus("connecting")
    try {
      const ws = new WebSocket(wsUrl(this.epoch ? { epoch: this.epoch, sequence: this.sequence } : undefined))
      this.ws = ws
      ws.onopen = () => {
        this.setStatus("open")
        if (!this.epoch) void this.resyncSnapshots()
      }
      ws.onclose = () => {
        this.ws = null
        this.setStatus("closed")
        if (!this.intentionalClose) {
          this.scheduleReconnect()
        }
      }
      ws.onerror = () => this.setStatus("closed")
      ws.onmessage = ev => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            channel?: string
            event?: EventEnvelopeV1
            type?: string
            cursor?: { epoch: string; sequence: number }
          }
          if (msg.channel === "event" && msg.event) this.handleEvent(msg.event)
          if (msg.channel === "control" && msg.type === "resync_required") {
            void this.resyncSnapshots().then(() => {
              if (!msg.cursor) return
              if (this.epoch !== msg.cursor.epoch || this.sequence < msg.cursor.sequence) {
                this.epoch = msg.cursor.epoch
                this.sequence = msg.cursor.sequence
              }
            })
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      this.setStatus("closed")
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      // only reconnect if server still expected
      void import("./serverMode").then(({ isPiServerReachable }) => {
        if (isPiServerReachable()) this.connect()
      })
    }, 1500)
  }

  private handleEvent(event: EventEnvelopeV1) {
    if (event.protocolVersion !== 1) return
    if (this.epoch !== event.epoch) {
      this.epoch = event.epoch
      this.sequence = 0
      void this.resyncSnapshots()
    }
    if (event.sequence <= this.sequence) return
    if (this.sequence > 0 && event.sequence > this.sequence + 1) void this.resyncSnapshots()
    this.sequence = event.sequence
    if (event.type === "session.snapshot" && event.payload) {
      const snap = event.payload as SessionSnapshotV1
      if (snap.session?.id && (!event.sessionId || event.sessionId === snap.session.id)) {
        trackPiSession(snap.session.id)
        applySnapshotToUi(snap, { activate: false })
      }
      return
    }
    if (event.type === "session.updated") {
      window.dispatchEvent(new CustomEvent("piui:sessions-changed"))
      return
    }
  }

  private resyncSnapshots(): Promise<void> {
    if (this.resyncing) return this.resyncing
    const ids = new Set([...listTrackedPiSessions(), ...sessionProjectionStore.getSessionIds()])
    this.resyncing = Promise.all([...ids].map(async id => {
      try {
        applySnapshotToUi(await fetchSnapshot(id), { activate: false })
      } catch {
        /* a deleted session is removed when the session list refreshes */
      }
    })).then(() => undefined).finally(() => { this.resyncing = null })
    return this.resyncing
  }

  close() {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
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
  const s = getPiEventSocket()
  s.connect()
  return s
}
