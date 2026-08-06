import { DEFAULT_HTTP_BASE, PROTOCOL_VERSION } from "@piui/protocol"
import { getDriverMode } from "@piui/pi-worker"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { authTokenPath, resolveAuthToken } from "./host/auth-token.ts"
import { createAppServer, firstLanAddress } from "./http.ts"
import { shutdownAppServer } from "./shutdown.ts"
import { attachEventWebSocket } from "./ws.ts"

const PORT = Number(process.env.PIUI_PORT ?? 8787)
const HOST = process.env.PIUI_HOST?.trim() || "127.0.0.1"
const requestedShutdownTimeout = Number(process.env.PIUI_SHUTDOWN_TIMEOUT_MS ?? 10_000)
const SHUTDOWN_TIMEOUT_MS = Number.isFinite(requestedShutdownTimeout) && requestedShutdownTimeout > 0
  ? requestedShutdownTimeout
  : 10_000
const driver = getDriverMode()

/**
 * Web 客户端目录：显式 PIUI_WEB_ROOT > 可执行文件旁的 web/（打包形态）>
 * 仓库内的 app 构建产物（开发态）。都没有就不托管，纯 API 模式。
 */
function resolveWebRoot(): string | undefined {
  const explicit = process.env.PIUI_WEB_ROOT?.trim()
  const candidates = [
    explicit,
    join(dirname(process.execPath), "web"),
    resolve(dirname(process.execPath), "../../packages/app/dist"),
    resolve(process.cwd(), "packages/app/dist"),
  ].filter((path): path is string => Boolean(path))
  return candidates.find(path => existsSync(join(path, "index.html")))
}

const webRoot = resolveWebRoot()
const authToken = resolveAuthToken()
const app = createAppServer({ authToken, share: { host: HOST, port: PORT }, staticRoot: webRoot })
const eventServer = attachEventWebSocket(app.server, {
  eventHub: app.eventHub,
  authToken,
  terminalManager: app.terminals,
  onSubscribe: send => {
    // Push the current activity snapshot so fresh subscribers see busy
    // sessions without waiting for the next change
    const snapshot = app.sessionHost.getActivitySnapshot()
    if (Object.keys(snapshot.sessions).length > 0) {
      send({
        channel: "event",
        event: {
          protocolVersion: PROTOCOL_VERSION,
          stream: { kind: "server", id: "server" },
          channel: "sessions.activity",
          cursor: app.eventHub.getCursor({ kind: "server", id: "server" }),
          eventId: `activity-snapshot-${Date.now()}`,
          timestamp: new Date().toISOString(),
          payload: snapshot as never,
        },
      })
    }
  },
})
app.server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`[piui-server] ${HOST}:${PORT} is already in use — another PiUI server may be running; stop it or set PIUI_PORT`)
  } else {
    console.error("[piui-server] server error", error)
  }
  process.exit(1)
})
app.server.listen(PORT, HOST, () => {
  console.info(`[piui-server] listening http://${HOST}:${PORT} (base ${DEFAULT_HTTP_BASE})`)
  console.info(`[piui-server] events ws://${HOST}:${PORT}/api/v1/events`)
  console.info(`[piui-server] terminal stream ws://${HOST}:${PORT}/api/v1/host/terminals/:terminalId/stream`)
  console.info(`[piui-server] driver=${driver}${driver === "pi" ? " (real models when prompt)" : " (no LLM)"}`)
  console.info(
    process.env.PIUI_AUTH_TOKEN
      ? "[piui-server] auth token from PIUI_AUTH_TOKEN"
      : `[piui-server] auth token at ${authTokenPath()}`,
  )
  if (HOST !== "127.0.0.1" && HOST !== "::1" && HOST !== "localhost") {
    const lanHost = HOST === "0.0.0.0" || HOST === "::" ? firstLanAddress() ?? HOST : HOST
    const shareUrl = `piui://connect?url=${encodeURIComponent(`http://${lanHost}:${PORT}`)}&token=${encodeURIComponent(authToken)}`
    console.info(`[piui-server] LAN sharing enabled, share link:\n  ${shareUrl}`)
    if (webRoot) {
      console.info(`[piui-server] web client (open on any device):\n  http://${lanHost}:${PORT}/?token=${encodeURIComponent(authToken)}`)
    }
  } else if (webRoot) {
    console.info(`[piui-server] web client:\n  http://${HOST}:${PORT}/?token=${encodeURIComponent(authToken)}`)
  }
})

let shuttingDown = false
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return
  shuttingDown = true
  console.info(`[piui-server] received ${signal}, shutting down`)
  void shutdownAppServer(app.server, eventServer, {
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
      onTimeout: () => {
      console.error(
        `[piui-server] shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; closing active HTTP connections`,
      )
      },
      cleanup: () => app.dispose(),
    })
    .finally(() => app.dispose())
    .catch(error => {
      console.error("[piui-server] shutdown failed", error)
      process.exitCode = 1
    })
}

process.once("SIGINT", () => shutdown("SIGINT"))
process.once("SIGTERM", () => shutdown("SIGTERM"))
