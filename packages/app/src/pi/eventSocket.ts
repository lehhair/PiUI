import type { EventEnvelopeV1, SessionSnapshotV1 } from "@piui/protocol"
import { getApiBase, getPiAuthToken } from "./sessionApi"
import { applySnapshotToUi } from "./applySnapshot"
import { isTrackedPiSession, trackPiSession } from "./piSessionIndex"

type Status = "idle" | "connecting" | "open" | "closed"

function wsUrl(): string {
  const base = getApiBase()
  const token = getPiAuthToken()
  const suffix = token ? `?token=${encodeURIComponent(token)}` : ""
  if (!base) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    return `${proto}//${window.location.host}/api/v1/events${suffix}`
  }
  return base.replace(/^http/, "ws") + "/api/v1/events" + suffix
}

class PiEventSocket {
  private ws: WebSocket | null = null
  private status: Status = "idle"
  private statusListeners = new Set<(s: Status) => void>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false

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
      const ws = new WebSocket(wsUrl())
      this.ws = ws
      ws.onopen = () => {
        this.setStatus("open")
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
          }
          if (msg.channel === "event" && msg.event) this.handleEvent(msg.event)
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
    if (event.type === "session.snapshot" && event.payload) {
      const snap = event.payload as SessionSnapshotV1
      if (snap.session?.id) {
        trackPiSession(snap.session.id)
        applySnapshotToUi(snap)
      }
      return
    }
    if (event.type === "session.updated") {
      window.dispatchEvent(new CustomEvent("piui:sessions-changed"))
      return
    }
    void isTrackedPiSession
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
