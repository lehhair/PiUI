import { PROTOCOL_VERSION } from "@piui/protocol"
import { getDriverMode } from "@piui/pi-worker"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Server as HttpServer } from "node:http"
import { authTokenPath, ensureCursorSecretEnv, resolveAuthToken } from "./host/auth-token.ts"
import { createAppServer, firstLanAddress } from "./http.ts"
import { shutdownAppServer } from "./shutdown.ts"
import { attachEventWebSocket } from "./ws.ts"

export interface ServerConfig {
  host: string
  port: number
  shutdownTimeoutMs: number
  driver: ReturnType<typeof getDriverMode>
  webRoot: string | null
  authToken?: string
}

export interface ServerConfigOverrides {
  host?: string
  port?: number
  webRoot?: string | null
  authToken?: string
  shutdownTimeoutMs?: number
}

export interface RunningPiUiServer {
  server: HttpServer
  config: ServerConfig
  stop(signal?: NodeJS.Signals): Promise<void>
}

export interface WebCliOptions extends ServerConfigOverrides {
  help: boolean
}

const DEFAULT_PORT = 8787
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

export function resolveServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ServerConfigOverrides = {},
): ServerConfig {
  const port = overrides.port === undefined
    ? parsePort(env.PIUI_PORT ?? String(DEFAULT_PORT))
    : parsePort(String(overrides.port))
  const host = overrides.host ?? (env.PIUI_HOST?.trim() || DEFAULT_HOST)
  const requestedShutdownTimeout = overrides.shutdownTimeoutMs ?? Number(env.PIUI_SHUTDOWN_TIMEOUT_MS ?? DEFAULT_SHUTDOWN_TIMEOUT_MS)
  const shutdownTimeoutMs = Number.isFinite(requestedShutdownTimeout) && requestedShutdownTimeout > 0
    ? requestedShutdownTimeout
    : DEFAULT_SHUTDOWN_TIMEOUT_MS
  const explicitWebRoot = overrides.webRoot === undefined ? env.PIUI_WEB_ROOT?.trim() : overrides.webRoot

  return {
    host,
    port,
    shutdownTimeoutMs,
    driver: getDriverMode(env),
    webRoot: explicitWebRoot === null ? null : explicitWebRoot || resolveWebRoot() || null,
    authToken: overrides.authToken,
  }
}

export function parseWebArgs(args: string[]): WebCliOptions {
  const options: WebCliOptions = { help: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--help" || arg === "-h") {
      options.help = true
      continue
    }
    if (arg === "--api-only") {
      options.webRoot = null
      continue
    }
    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
    if (name === "--host") options.host = value
    else if (name === "--port") options.port = parsePort(value)
    else if (name === "--web-root") options.webRoot = value
    else throw new Error(`unknown web option: ${arg}`)
  }
  return options
}

export function printWebHelp(): void {
  console.info(`Usage: pi-worker web [options]

Options:
  --host <host>       Listen address (default: 127.0.0.1)
  --port <port>       Listen port (default: 8787)
  --web-root <path>   Serve a specific web build directory
  --api-only          Disable SPA hosting while keeping the same service
  -h, --help          Show this help`)
}

export async function startPiUiServer(
  overrides: ServerConfigOverrides = {},
  options: { installSignalHandlers?: boolean } = {},
): Promise<RunningPiUiServer> {
  const config = resolveServerConfig(process.env, overrides)
  const authToken = config.authToken ?? resolveAuthToken()
  // 分页光标密钥持久化并注入环境，保证 worker 重启后客户端旧光标仍有效
  // （必须在任何 worker spawn 之前完成）。
  ensureCursorSecretEnv()
  // POST /api/v1/host/shutdown 的钩子：createAppServer 返回后才定义 stop()，
  // 用可变引用延迟绑定 —— HTTP 请求只能发生在 listen 之后，届时 stop 已就位。
  let shutdownHook: (() => Promise<void>) | undefined
  const app = createAppServer({
    authToken,
    share: { host: config.host, port: config.port },
    staticRoot: config.webRoot ?? undefined,
    onShutdown: () => shutdownHook?.(),
  })
  const eventServer = attachEventWebSocket(app.server, {
    eventHub: app.eventHub,
    authToken,
    terminalManager: app.terminals,
    onSubscribe: send => {
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

  let listening = false
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (listening) {
          console.error("[piui-server] server error", error)
          return
        }
        if (error.code === "EADDRINUSE") {
          rejectListen(new Error(`${config.host}:${config.port} is already in use; use --port or PIUI_PORT`))
        } else {
          rejectListen(error)
        }
      }
      app.server.once("error", onError)
      app.server.listen(config.port, config.host, () => {
        listening = true
        app.server.removeListener("error", onError)
        resolveListen()
      })
    })
  } catch (error) {
    await shutdownAppServer(app.server, eventServer, { timeoutMs: config.shutdownTimeoutMs, cleanup: () => app.dispose() }).catch(() => undefined)
    throw error
  }
  app.server.on("error", error => console.error("[piui-server] server error", error))

  // 后台预热共享 catalog worker：health 走只读快照保持毫秒级响应，同时让
  // 首个 catalog 命令/会话 attach 不必承担 ~300MB SDK 冷启动；预热失败
  // 不影响服务（真正用到时会重新孵化）。
  void app.supervisor.getCatalogHandshake().catch(() => undefined)

  console.info(`[piui-server] listening http://${config.host}:${config.port}`)
  console.info(`[piui-server] events ws://${config.host}:${config.port}/api/v1/events`)
  console.info(`[piui-server] terminal stream ws://${config.host}:${config.port}/api/v1/host/terminals/:terminalId/stream`)
  console.info(`[piui-server] driver=${config.driver}${config.driver === "pi" ? " (real models when prompt)" : " (no LLM)"}`)
  console.info(
    config.authToken
      ? "[piui-server] auth token configured by launcher"
      : process.env.PIUI_AUTH_TOKEN
      ? "[piui-server] auth token from PIUI_AUTH_TOKEN"
      : `[piui-server] auth token at ${authTokenPath()}`,
  )
  const lanHost = config.host === "0.0.0.0" || config.host === "::" ? firstLanAddress() ?? config.host : config.host
  if (config.webRoot) console.info(`[piui-server] web client: http://${lanHost}:${config.port}/?token=${encodeURIComponent(authToken)}`)
  if (config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost") {
    console.info(`[piui-server] LAN sharing enabled at http://${lanHost}:${config.port}`)
  }

  let stopped = false
  const stop = async (signal?: NodeJS.Signals): Promise<void> => {
    if (stopped) return
    stopped = true
    if (signal) console.info(`[piui-server] received ${signal}, shutting down`)
    await shutdownAppServer(app.server, eventServer, {
      timeoutMs: config.shutdownTimeoutMs,
      onTimeout: () => console.error(`[piui-server] shutdown exceeded ${config.shutdownTimeoutMs}ms; closing active HTTP connections`),
      cleanup: () => app.dispose(),
    })
  }
  shutdownHook = stop

  if (options.installSignalHandlers !== false) {
    process.once("SIGINT", () => { void stop("SIGINT").catch(error => { console.error("[piui-server] shutdown failed", error); process.exitCode = 1 }) })
    process.once("SIGTERM", () => { void stop("SIGTERM").catch(error => { console.error("[piui-server] shutdown failed", error); process.exitCode = 1 }) })

    // 未捕获异常 = 进程级错误，必须退出（Node 事件循环状态已不可信），
    // 但不能直接崩——否则监听 socket 和活动连接僵死，Windows 上留下孤儿
    // TCP 实体占住端口（与 taskkill /F 同一类问题）。先走 stop() 优雅
    // 关闭再退出，日志里带堆栈便于定位死因。
    process.once("uncaughtException", error => {
      console.error("[piui-server] uncaught exception; shutting down gracefully:", error)
      stop().finally(() => process.exit(1))
    })
    // 单个请求/事件的异步疏忽不应杀死整个服务：记录并继续。
    process.on("unhandledRejection", reason => {
      console.error(`[piui-server] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
    })
  }

  return { server: app.server, config, stop }
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PIUI_PORT must be an integer from 1 to 65535, received: ${value}`)
  }
  return port
}

function resolveWebRoot(): string | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(dirname(process.execPath), "web"),
    join(moduleDir, "../../app/dist"),
    resolve(process.cwd(), "packages/app/dist"),
  ]
  return candidates.find(candidate => existsSync(join(candidate, "index.html")))
}
