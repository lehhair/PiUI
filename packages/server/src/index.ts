/**
 * Phase 0 placeholder — full orchestrator lands in Phase 1.
 * Bind 127.0.0.1 only. No Pi model calls.
 */
import { createServer } from "node:http"
import { DEFAULT_HTTP_BASE, PROTOCOL_VERSION } from "@piui/protocol"

const PORT = Number(process.env.PIUI_PORT ?? 8787)
const HOST = "127.0.0.1"

const server = createServer((req, res) => {
  if (req.url === "/api/v1/health" || req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        service: "piui-server",
        phase: 0,
      }),
    )
    return
  }
  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: "not_found", phase: 0 }))
})

server.listen(PORT, HOST, () => {
  console.info(`[piui-server] phase0 listening http://${HOST}:${PORT} (base ${DEFAULT_HTTP_BASE})`)
})
