import { DEFAULT_HTTP_BASE } from "@piui/protocol"
import { getDriverMode } from "@piui/pi-worker"
import { authTokenPath, resolveAuthToken } from "./host/auth-token.ts"
import { createAppServer } from "./http.ts"
import { shutdownAppServer } from "./shutdown.ts"
import { attachEventWebSocket } from "./ws.ts"

const PORT = Number(process.env.PIUI_PORT ?? 8787)
const HOST = "127.0.0.1"
const requestedShutdownTimeout = Number(process.env.PIUI_SHUTDOWN_TIMEOUT_MS ?? 10_000)
const SHUTDOWN_TIMEOUT_MS = Number.isFinite(requestedShutdownTimeout) && requestedShutdownTimeout > 0
  ? requestedShutdownTimeout
  : 10_000
const driver = getDriverMode()

const authToken = resolveAuthToken()
const app = createAppServer({ authToken })
const eventServer = attachEventWebSocket(app.server, { eventHub: app.eventHub, authToken })
app.server.listen(PORT, HOST, () => {
  console.info(`[piui-server] listening http://${HOST}:${PORT} (base ${DEFAULT_HTTP_BASE})`)
  console.info(`[piui-server] events ws://${HOST}:${PORT}/api/v1/events`)
  console.info(`[piui-server] driver=${driver}${driver === "pi" ? " (real models when prompt)" : " (no LLM)"}`)
  console.info(
    process.env.PIUI_AUTH_TOKEN
      ? "[piui-server] auth token from PIUI_AUTH_TOKEN"
      : `[piui-server] auth token at ${authTokenPath()}`,
  )
})

let shuttingDown = false
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return
  shuttingDown = true
  console.info(`[piui-server] received ${signal}, shutting down`)
  void app.supervisor.dispose()
    .then(() => shutdownAppServer(app.server, eventServer, {
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
      onTimeout: () => console.error(
        `[piui-server] shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; closing active HTTP connections`,
      ),
    }))
    .catch(error => {
      console.error("[piui-server] shutdown failed", error)
      process.exitCode = 1
    })
}

process.once("SIGINT", () => shutdown("SIGINT"))
process.once("SIGTERM", () => shutdown("SIGTERM"))
