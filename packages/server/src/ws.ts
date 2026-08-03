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
  TERMINAL_STREAM_PROTOCOL_VERSION,
  type TerminalStreamClientFrame,
  type TerminalStreamServerFrame,
} from "@piui/protocol"
import type { EventHub } from "./event-hub.ts"
import { requestHasAllowedOrigin, requestHasValidToken, timingSafeTokenEquals } from "./host/security.ts"
import { resolveAuthToken } from "./host/auth-token.ts"
import type { TerminalManager } from "./host/terminal-manager.ts"

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
// Client frames are tiny (ping/subscribe); cap to avoid buffering huge frames.
const MAX_MESSAGE_BYTES = 1024 * 1024
const MAX_TERMINAL_BUFFERED_BYTES = 8 * 1024 * 1024
const TERMINAL_OUTPUT_CHUNK_BYTES = 32 * 1024
const TERMINAL_PATH = /^\/api\/v1\/host\/terminals\/([^/]+)\/stream$/

export interface EventWebSocketOptions {
  eventHub: EventHub
  authToken?: string | null
  /** Called after a client (re)subscribes — push per-connection snapshots */
  onSubscribe?: (send: (message: EventServerMessage) => void) => void
  terminalManager?: TerminalManager
}

export function attachEventWebSocket(server: HttpServer, options: EventWebSocketOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  const eventHub = options.eventHub
  const authToken = options.authToken === undefined ? resolveAuthToken() : options.authToken
  const terminalConnections = new WeakMap<IncomingMessage, { terminalId: string; workspacePath: string }>()

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
    const terminalMatch = TERMINAL_PATH.exec(url.pathname)
    const isEventPath = url.pathname === "/api/v1/events"
    if ((!isEventPath && !terminalMatch) || !requestHasAllowedOrigin(req) || !hasToken) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
      socket.destroy()
      return
    }
    if (terminalMatch) {
      if (!options.terminalManager) {
        socket.write("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        socket.destroy()
        return
      }
      const terminalId = decodePathSegment(terminalMatch[1]!)
      const ticket = url.searchParams.get("ticket")
      const workspacePath = ticket ? options.terminalManager.consumeConnectToken(terminalId, ticket) : undefined
      if (!workspacePath) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        socket.destroy()
        return
      }
      terminalConnections.set(req, { terminalId, workspacePath })
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req)
    })
  })

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // Without an error listener, ws emits 'error' synchronously on receiver
    // errors (oversized frames, bad UTF-8, invalid opcodes) and Node throws,
    // crashing the whole process. Swallow per-socket errors; close handles the rest.
    ws.on("error", () => undefined)
    const terminal = terminalConnections.get(req)
    if (terminal && options.terminalManager) {
      attachTerminalConnection(ws, options.terminalManager, terminal.terminalId, terminal.workspacePath, req)
      return
    }
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
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          rejectProtocol(ws)
          return
        }
        send(ws, { type: "pong", protocolVersion: PROTOCOL_VERSION, t: Date.now() })
        return
      }
      if (message.type !== "subscribe") return
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        rejectProtocol(ws)
        return
      }
      if (!Array.isArray(message.streams) || message.streams.length > 256) return

      subscribed.clear()
      const resync: Extract<EventServerMessage, { type: "resync_required" }>["streams"] = {}
      const seenStreams = new Set<string>()
      for (const stream of message.streams) {
        if (!stream.id || !isEventStreamKind(stream.kind)) continue
        const key = eventStreamKey(stream)
        if (seenStreams.has(key)) continue
        seenStreams.add(key)
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

function attachTerminalConnection(
  ws: WebSocket,
  manager: TerminalManager,
  terminalId: string,
  workspacePath: string,
  req: IncomingMessage,
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  const cursorValue = url.searchParams.get("cursor")
  const cursor = cursorValue === null ? undefined : Number(cursorValue)
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < -1)) {
    sendTerminalProblem(ws, "INVALID_REQUEST", "terminal cursor must be an integer >= -1")
    ws.close(1008, "invalid cursor")
    return
  }

  let closed = false
  let writing = false
  let queuedBytes = 0
  const queue: string[] = []
  let closeAfterFlush: { code: number; reason: string } | undefined
  const close = (code = 1000, reason = "") => {
    if (closed) return
    closed = true
    ws.close(code, reason)
  }
  const closeWhenDrained = (code: number, reason: string) => {
    if (closed) return
    closeAfterFlush = { code, reason }
    pump()
  }
  const pump = () => {
    if (closed || writing) return
    const next = queue.shift()
    if (!next) {
      queuedBytes = 0
      if (closeAfterFlush) {
        const pending = closeAfterFlush
        closeAfterFlush = undefined
        close(pending.code, pending.reason)
      }
      return
    }
    queuedBytes -= Buffer.byteLength(next)
    writing = true
    ws.send(next, error => {
      writing = false
      if (error) {
        close(1011, "terminal stream failed")
        return
      }
      pump()
    })
  }
  const sendFrame = (frame: TerminalStreamServerFrame) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount > MAX_TERMINAL_BUFFERED_BYTES) {
      close(1013, "terminal client too slow")
      return
    }
    const data = JSON.stringify(frame)
    queuedBytes += Buffer.byteLength(data)
    if (queuedBytes > MAX_TERMINAL_BUFFERED_BYTES) {
      close(1013, "terminal client too slow")
      return
    }
    queue.push(data)
    pump()
  }

  let attachment: ReturnType<TerminalManager["attach"]>
  try {
    attachment = manager.attach(
      workspacePath,
      terminalId,
      cursor,
      data => {
        for (const chunk of splitTerminalOutput(data)) {
          outputCursor += chunk.length
          sendFrame({ type: "output", cursor: outputCursor, data: chunk })
        }
      },
      event => {
        sendFrame({ type: "exit", cursor: outputCursor, exitCode: event.exitCode })
        closeWhenDrained(1001, "terminal exited")
      },
      title => sendFrame({ type: "title", title }),
    )
  } catch (error) {
    const code = errorCode(error)
    sendTerminalProblem(ws, code, error instanceof Error ? error.message : String(error))
    close(code === "TERMINAL_CURSOR_EXPIRED" ? 1008 : 1000, code)
    return
  }

  let outputCursor = attachment.replayCursor
  let terminal
  try {
    terminal = manager.get(workspacePath, terminalId)
  } catch (error) {
    attachment.detach()
    sendTerminalProblem(ws, errorCode(error), error instanceof Error ? error.message : String(error))
    close(1000, "terminal not found")
    return
  }
  sendFrame({ type: "hello", protocolVersion: TERMINAL_STREAM_PROTOCOL_VERSION, terminal, cursor: attachment.cursor })
  for (const chunk of splitTerminalOutput(attachment.replay)) {
    outputCursor += chunk.length
    sendFrame({ type: "output", cursor: outputCursor, data: chunk })
  }
  sendFrame({ type: "ready", cursor: attachment.cursor })
  attachment.activate()

  ws.on("message", raw => {
    if (closed) return
    let frame: TerminalStreamClientFrame
    try {
      frame = JSON.parse(String(raw)) as TerminalStreamClientFrame
    } catch {
      sendTerminalProblem(ws, "INVALID_REQUEST", "invalid terminal stream frame")
      return
    }
    try {
      if (frame.type === "input" && typeof frame.data === "string") {
        manager.write(workspacePath, terminalId, frame.data)
      } else if (
        frame.type === "resize" &&
        Number.isSafeInteger(frame.rows) && frame.rows >= 1 && frame.rows <= 500 &&
        Number.isSafeInteger(frame.cols) && frame.cols >= 1 && frame.cols <= 500
      ) {
        manager.update(workspacePath, terminalId, { rows: frame.rows, cols: frame.cols })
      } else if (frame.type === "ping" && frame.protocolVersion === TERMINAL_STREAM_PROTOCOL_VERSION) {
        sendFrame({ type: "pong", protocolVersion: TERMINAL_STREAM_PROTOCOL_VERSION, t: Date.now() })
      } else {
        sendTerminalProblem(ws, "INVALID_REQUEST", "invalid terminal stream frame")
      }
    } catch (error) {
      sendTerminalProblem(ws, errorCode(error), error instanceof Error ? error.message : String(error))
    }
  })
  ws.on("close", () => {
    closed = true
    attachment.detach()
  })
}

function splitTerminalOutput(data: string): string[] {
  const chunks: string[] = []
  for (let index = 0; index < data.length; index += TERMINAL_OUTPUT_CHUNK_BYTES) {
    chunks.push(data.slice(index, index + TERMINAL_OUTPUT_CHUNK_BYTES))
  }
  return chunks
}

function sendTerminalProblem(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: "problem", problem: { code, message } }))
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "INTERNAL"
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function rejectProtocol(ws: WebSocket): void {
  send(ws, {
    channel: "control",
    type: "problem",
    problem: {
      code: "PROTOCOL_VERSION_MISMATCH",
      message: "event protocol version mismatch",
    },
  })
  ws.close(1002, "protocol version mismatch")
}
