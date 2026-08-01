import type { Server as HttpServer, IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, WebSocket } from "ws"
import {
  EVENT_WS_SUBPROTOCOL,
  eventStreamKey,
  PROTOCOL_VERSION,
  type EventClientMessage,
  type EventServerMessage,
  type EventStreamRef,
} from "@piui/protocol"
import type { EventHub } from "./event-hub.ts"
import { requestHasAllowedOrigin, requestHasValidToken, timingSafeTokenEquals } from "./host/security.ts"
import { resolveAuthToken } from "./host/auth-token.ts"

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
// Client frames are tiny (ping/subscribe); cap to avoid buffering huge frames.
const MAX_MESSAGE_BYTES = 1024 * 1024

export interface EventWebSocketOptions {
  eventHub: EventHub
  authToken?: string | null
  /** Called after a client (re)subscribes — push per-connection snapshots */
  onSubscribe?: (send: (message: EventServerMessage) => void) => void
}

export function attachEventWebSocket(server: HttpServer, options: EventWebSocketOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  const eventHub = options.eventHub
  const authToken = options.authToken === undefined ? resolveAuthToken() : options.authToken

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1")
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
      socket.destroy()
      return
    }
    const wsToken = url.searchParams.get("token")
    const hasToken = requestHasValidToken(req, authToken) ||
      (authToken !== null && wsToken !== null && timingSafeTokenEquals(wsToken, authToken))
    if (url.pathname !== "/api/v1/events" || !requestHasAllowedOrigin(req) || !hasToken) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req)
    })
  })

  wss.on("connection", (ws: WebSocket) => {
    // Without an error listener, ws emits 'error' synchronously on receiver
    // errors (oversized frames, bad UTF-8, invalid opcodes) and Node throws,
    // crashing the whole process. Swallow per-socket errors; close handles the rest.
    ws.on("error", () => undefined)
    attachConnection(ws, eventHub, options.onSubscribe)
  })

  return wss
}

export function closeEventWebSocket(
  wss: WebSocketServer,
  callback?: (error?: Error) => void,
): void {
  for (const client of wss.clients) client.terminate()
  wss.close(callback)
}

function attachConnection(ws: WebSocket, eventHub: EventHub, onSubscribe?: (send: (message: EventServerMessage) => void) => void): void {
  const subscribed = new Set<string>()
  send(ws, {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    service: "piui-server",
    subprotocol: EVENT_WS_SUBPROTOCOL,
  })

  const unsubscribe = eventHub.subscribe(event => {
    if (subscribed.has(eventStreamKey(event.stream))) send(ws, { channel: "event", event })
  })

  ws.on("message", raw => {
    try {
      const message = JSON.parse(String(raw)) as EventClientMessage
      if (message.type === "ping") {
        send(ws, { type: "pong", protocolVersion: PROTOCOL_VERSION, t: Date.now() })
        return
      }
      if (message.type !== "subscribe" || message.protocolVersion !== PROTOCOL_VERSION) return
      if (!Array.isArray(message.streams) || message.streams.length > 256) return

      subscribed.clear()
      const resync: Extract<EventServerMessage, { type: "resync_required" }>["streams"] = {}
      for (const stream of message.streams) {
        if (!stream.id || !isEventStreamKind(stream.kind)) continue
        const key = eventStreamKey(stream)
        subscribed.add(key)
        const cursor = message.cursors?.[key as keyof typeof message.cursors]
        const replay = eventHub.replaySince(stream, cursor)
        if (replay.resyncRequired) {
          resync[key] = {
            cursor: eventHub.getCursor(stream),
            reason: replay.reason ?? "missing_cursor",
          }
          continue
        }
        for (const event of replay.events) send(ws, { channel: "event", event })
      }
      if (Object.keys(resync).length > 0) {
        send(ws, { channel: "control", type: "resync_required", streams: resync })
      }
      onSubscribe?.(message => send(ws, message))
    } catch {
      /* ignore malformed client messages */
    }
  })
  ws.on("close", unsubscribe)
}

function isEventStreamKind(value: string): value is EventStreamRef["kind"] {
  return value === "server" || value === "workspace" || value === "session" || value === "provider" || value === "resources"
}

function send(ws: WebSocket, message: EventServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    ws.close(1013, "event client too slow")
    return
  }
  ws.send(JSON.stringify(message))
}
