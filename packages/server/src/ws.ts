import type { Server as HttpServer, IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, WebSocket } from "ws"
import type { EventEnvelopeV1 } from "@piui/protocol"
import { eventHub } from "./event-hub.ts"
import { requestHasAllowedOrigin, requestHasValidToken } from "./security.ts"

export function attachEventWebSocket(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true })
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

  wss.on("connection", (ws: WebSocket) => {
    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        service: "piui-server",
      }),
    )

    const unsub = eventHub.subscribe((event: EventEnvelopeV1) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ channel: "event", event }))
      }
    })

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string }
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", t: Date.now() }))
        }
      } catch {
        /* ignore */
      }
    })

    ws.on("close", () => unsub())
  })

  return wss
}
