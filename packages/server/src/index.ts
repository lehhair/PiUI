/**
 * PiUI orchestrator — health, workspace, sessions, WS events.
 * Driver: PIUI_DRIVER=mock (default) | pi
 * Real Pi will call configured models when prompted.
 */
import { DEFAULT_HTTP_BASE } from "@piui/protocol"
import { getDriverMode } from "@piui/pi-worker"
import { createAppServer } from "./http.ts"
import { attachEventWebSocket } from "./ws.ts"

const PORT = Number(process.env.PIUI_PORT ?? 8787)
const HOST = "127.0.0.1"
const driver = getDriverMode()

const server = createAppServer()
attachEventWebSocket(server)
server.listen(PORT, HOST, () => {
  console.info(`[piui-server] listening http://${HOST}:${PORT} (base ${DEFAULT_HTTP_BASE})`)
  console.info(`[piui-server] events ws://${HOST}:${PORT}/api/v1/events`)
  console.info(`[piui-server] driver=${driver}${driver === "pi" ? " (real models when prompt)" : " (no LLM)"}`)
})
