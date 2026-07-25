import type { Server as HttpServer, IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, WebSocket } from "ws"
import {
  EVENT_WS_SUBPROTOCOL_V2,
  eventStreamKeyV2,
  type AnyEventEnvelopeV2,
  type EventCursorV1,
  type EventEnvelopeV1,
  type EventServerMessageV2,
  type EventSubscribeMessageV2,
} from "@piui/protocol"
import { getBoundEventHub, type EventHub } from "./event-hub.ts"
import { requestHasAllowedOrigin, requestHasValidToken } from "./security.ts"

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

export function attachEventWebSocket(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true })
  const eventHub = getBoundEventHub(server)
  const authToken = process.env.PIUI_AUTH_TOKEN

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const wsToken = url.searchParams.get("token")
    const hasToken = !authToken || wsToken === authToken || requestHasValidToken(req, authToken)
    if (url.pathname !== "/api/v1/events" || !requestHasAllowedOrigin(req) || !hasToken) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req)
    })
  })

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    if (ws.protocol === EVENT_WS_SUBPROTOCOL_V2) attachV2Connection(ws, eventHub)
    else attachV1Connection(ws, req, eventHub)
  })

  return wss
}

function attachV1Connection(ws: WebSocket, req: IncomingMessage, eventHub: EventHub): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  const cursorEpoch = url.searchParams.get("cursorEpoch")
  const cursorSequence = Number(url.searchParams.get("cursorSequence"))
  const requestedCursor: EventCursorV1 | undefined =
    cursorEpoch && Number.isSafeInteger(cursorSequence) && cursorSequence >= 0
      ? { epoch: cursorEpoch, sequence: cursorSequence }
      : undefined
  const replay = eventHub.replaySince(requestedCursor)
  const cursor = eventHub.getCursor()

  send(ws, { type: "hello", protocolVersion: 1, service: "piui-server", cursor })
  if (replay.resyncRequired) send(ws, { channel: "control", type: "resync_required", cursor })
  else for (const event of replay.events) send(ws, { channel: "event", event })

  const unsubscribe = eventHub.subscribe((event: EventEnvelopeV1) => {
    send(ws, { channel: "event", event })
  })
  ws.on("message", raw => {
    try {
      const message = JSON.parse(String(raw)) as { type?: string }
      if (message.type === "ping") send(ws, { type: "pong", t: Date.now() })
    } catch {
      /* ignore malformed legacy messages */
    }
  })
  ws.on("close", unsubscribe)
}

function attachV2Connection(ws: WebSocket, eventHub: EventHub): void {
  const subscribed = new Set<string>()
  sendV2(ws, {
    type: "hello",
    protocolVersion: 2,
    service: "piui-server",
    subprotocol: EVENT_WS_SUBPROTOCOL_V2,
  })

  const unsubscribe = eventHub.subscribeV2((event: AnyEventEnvelopeV2) => {
    if (subscribed.has(eventStreamKeyV2(event.stream))) sendV2(ws, { channel: "event", event })
  })

  ws.on("message", raw => {
    try {
      const message = JSON.parse(String(raw)) as unknown
      if (isPingMessageV2(message)) {
        sendV2(ws, { type: "pong", protocolVersion: 2, t: Date.now() })
        return
      }
      if (!isSubscribeMessageV2(message) || message.streams.length > 256) return

      subscribed.clear()
      const resync: Extract<EventServerMessageV2, { type: "resync_required" }>["streams"] = {}
      for (const stream of message.streams) {
        if (!stream.id || !isEventStreamKind(stream.kind)) continue
        const key = eventStreamKeyV2(stream)
        subscribed.add(key)
        const replay = eventHub.replaySinceV2(stream, message.cursors[key])
        if (replay.resyncRequired) {
          resync[key] = {
            cursor: eventHub.getCursorV2(stream),
            reason: replay.reason ?? "missing_cursor",
          }
          continue
        }
        for (const event of replay.events) sendV2(ws, { channel: "event", event })
      }
      if (Object.keys(resync).length > 0) {
        sendV2(ws, { channel: "control", type: "resync_required", streams: resync })
      }
    } catch {
      /* ignore malformed v2 messages */
    }
  })
  ws.on("close", unsubscribe)
}

function isPingMessageV2(value: unknown): value is { type: "ping"; protocolVersion: 2 } {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "ping" &&
    (value as { protocolVersion?: unknown }).protocolVersion === 2,
  )
}

function isSubscribeMessageV2(value: unknown): value is EventSubscribeMessageV2 {
  if (!value || typeof value !== "object") return false
  const message = value as Partial<EventSubscribeMessageV2>
  return (
    message.type === "subscribe" &&
    message.protocolVersion === 2 &&
    Array.isArray(message.streams) &&
    Boolean(message.cursors) &&
    typeof message.cursors === "object"
  )
}

function isEventStreamKind(value: string): value is "server" | "workspace" | "session" | "provider" | "resources" {
  return value === "server" || value === "workspace" || value === "session" || value === "provider" || value === "resources"
}

function sendV2(ws: WebSocket, message: EventServerMessageV2): void {
  send(ws, message)
}

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    ws.close(1013, "event client too slow")
    return
  }
  ws.send(JSON.stringify(message))
}
