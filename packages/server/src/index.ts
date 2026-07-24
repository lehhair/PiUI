/**
 * PiUI orchestrator — Phase 1: health + workspace + safe file list/read.
 * No Pi model calls.
 */
import { DEFAULT_HTTP_BASE } from "@piui/protocol"
import { createAppServer } from "./http.ts"

const PORT = Number(process.env.PIUI_PORT ?? 8787)
const HOST = "127.0.0.1"

const server = createAppServer()
server.listen(PORT, HOST, () => {
  console.info(`[piui-server] phase1 listening http://${HOST}:${PORT} (base ${DEFAULT_HTTP_BASE})`)
})
