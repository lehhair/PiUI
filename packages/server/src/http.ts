import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { networkInterfaces } from "node:os"
import {
  PI_PARITY_SDK_VERSION,
  PROTOCOL_VERSION,
  isErrorCode,
  problem,
  problemFromError,
  type HealthResponse,
  type JsonObject,
  type ShareInfo,
} from "@piui/protocol"
import { EventHub } from "./event-hub.ts"
import { RuntimeSupervisor } from "./pi/supervisor.ts"
import { SessionHost } from "./pi/session-host.ts"
import { WorkspaceStore } from "./host/workspace-store.ts"
import { WorkspaceWatcher } from "./host/workspace-watcher.ts"
import { MAX_JSON_BODY_BYTES, requestHasAllowedOrigin, requestHasValidToken } from "./host/security.ts"
import { resolveAuthToken } from "./host/auth-token.ts"
import { PathSafetyError } from "./host/path-safety.ts"
import { defaultWorkspaceRoot, HostRuntime } from "./host/command-table.ts"
import { TerminalManager } from "./host/terminal-manager.ts"
import { createStaticServer } from "./static.ts"

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,if-match",
}

function sendJson(res: ServerResponse, status: number, body: unknown): boolean {
  if (res.destroyed || res.writableEnded) return false
  const data = JSON.stringify(body)
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(data),
      ...CORS_HEADERS,
    })
    res.end(data)
    return true
  } catch {
    return false
  }
}

function sendProblem(res: ServerResponse, status: number, error: unknown): boolean {
  const p = problemFromError(error)
  return sendJson(res, status, problem(isErrorCode(p.code) ? p.code : "INTERNAL", p.message))
}

async function readBody(req: IncomingMessage, signal?: AbortSignal, maxBytes = MAX_JSON_BODY_BYTES): Promise<JsonObject> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    throwIfAborted(signal)
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error("request body too large"), { code: "INVALID_REQUEST" })
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  let body: unknown
  try {
    body = JSON.parse(raw || "{}")
  } catch {
    throw Object.assign(new Error("invalid json"), { code: "INVALID_REQUEST" })
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("json body must be an object"), { code: "INVALID_REQUEST" })
  }
  return body as JsonObject
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw Object.assign(new Error("request aborted"), { code: "REQUEST_ABORTED" })
}

function requestScope(req: IncomingMessage, res: ServerResponse): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  let responseFinished = false
  const abort = () => controller.abort()
  const abortIncompleteRequest = () => {
    if (!req.complete) controller.abort()
  }
  const abortIncompleteResponse = () => {
    if (!responseFinished && !res.writableFinished) controller.abort()
  }
  const markFinished = () => { responseFinished = true }
  req.once("aborted", abort)
  req.once("close", abortIncompleteRequest)
  res.once("finish", markFinished)
  res.once("close", abortIncompleteResponse)
  return {
    signal: controller.signal,
    cleanup: () => {
      req.removeListener("aborted", abort)
      req.removeListener("close", abortIncompleteRequest)
      res.removeListener("finish", markFinished)
      res.removeListener("close", abortIncompleteResponse)
    },
  }
}

function parseUrl(req: IncomingMessage): URL | null {
  const host = req.headers.host ?? "127.0.0.1"
  try {
    return new URL(req.url ?? "/", `http://${host}`)
  } catch {
    // Malformed Host header (e.g. invalid port) or invalid URL -> 400.
    return null
  }
}

function invalidRequest(message: string): Error {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST" })
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // Malformed percent-encoding -> treat as an invalid request.
    throw invalidRequest(`malformed percent-encoding in path segment`)
  }
}

export function firstLanAddress(): string | undefined {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address
    }
  }
  return undefined
}

function commandParams(body: JsonObject): JsonObject | undefined {
  if (body.params && typeof body.params === "object" && !Array.isArray(body.params)) {
    return body.params as JsonObject
  }
  const { id: _id, ...params } = body
  return Object.keys(params).length > 0 ? params : undefined
}

function isSubmittedCommand(value: unknown): value is { record: unknown; promise: Promise<unknown> } {
  return !!value && typeof value === "object" && "record" in value && "promise" in value
}

export interface CreateAppServerOptions {
  supervisor?: RuntimeSupervisor
  sessionHost?: SessionHost
  eventHub?: EventHub
  authToken?: string | null
  /** Bind address, used to build the share link other clients connect with. */
  share?: { host: string; port: number }
  /** Web client build directory; when it exists the server hosts the SPA. */
  staticRoot?: string
}

export interface AppServer {
  server: Server
  eventHub: EventHub
  sessionHost: SessionHost
  supervisor: RuntimeSupervisor
  terminals: TerminalManager
  dispose(): Promise<void>
}

export function createAppServer(options: CreateAppServerOptions = {}): AppServer {
  const store = new WorkspaceStore()
  const hub = options.eventHub ?? new EventHub()
  const supervisor = options.supervisor ?? new RuntimeSupervisor()
  const sessions = options.sessionHost ?? new SessionHost(supervisor, hub)
  const watcher = new WorkspaceWatcher(hub)
  const terminals = new TerminalManager({
    publish: (workspacePath, channel, payload) => {
      hub.publish({ kind: "workspace", id: workspacePath }, channel, payload)
    },
  })
  const host = new HostRuntime({ store, watcher, sessions, terminals })
  const authToken = options.authToken === undefined ? resolveAuthToken() : options.authToken
  const staticServer = options.staticRoot ? createStaticServer(options.staticRoot) : undefined
  let disposal: Promise<void> | undefined

  const closeHttpServer = (): Promise<void> => {
    if (!server.listening) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
  }

  const server = createServer(async (req, res) => {
    const scope = requestScope(req, res)
    try {
      const url = parseUrl(req)
      if (!url) {
        return sendProblem(res, 400, Object.assign(new Error("malformed request URL"), { code: "INVALID_REQUEST" }))
      }
      const method = req.method ?? "GET"
      const p = url.pathname

      // Web 客户端静态托管：/api 之外的 GET/HEAD 不走 token——页面本身必须
      // 公开可达，鉴权由 API 层把守（token 通过分享链接带进客户端）
       if (staticServer && (method === "GET" || method === "HEAD") && p !== "/api" && !p.startsWith("/api/")) {
        if (staticServer.serve(req, res, p)) return
        return sendProblem(res, 404, Object.assign(new Error("not found"), { code: "NOT_FOUND" }))
      }

      if (!requestHasAllowedOrigin(req)) {
        return sendProblem(res, 403, Object.assign(new Error("origin not allowed"), { code: "FORBIDDEN" }))
      }
      if (typeof req.headers.origin === "string") {
        res.setHeader("access-control-allow-origin", req.headers.origin)
        res.setHeader("vary", "Origin")
      }
      if (method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS)
        res.end()
        return
      }
      if (!requestHasValidToken(req, authToken)) {
        return sendProblem(res, 401, Object.assign(new Error("missing or invalid authorization token"), { code: "UNAUTHORIZED" }))
      }

      if (method === "GET" && p === "/api/v1/host/health") {
        // health 是高频只读探测：只读 catalog worker 的握手快照，绝不在
        // 请求路径上孵化/等待 worker（~300MB SDK 冷启动动辄数秒，远超
        // 客户端健康超时，会把「活着」的服务误判为不可达）。未就绪时
        // 回退 parity 常量；worker 由启动时的后台预热负责孵化。
        const handshake = await supervisor.peekCatalogHandshake(3_000).catch(() => undefined)
        const body: HealthResponse = {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          service: "piui-server",
          piSdkVersion: handshake?.piSdkVersion ?? PI_PARITY_SDK_VERSION,
          piSdkVerified: handshake?.piSdkVerified,
          piSdkFallback: handshake?.piSdkFallback ?? null,
          processId: process.pid,
        }
        return sendJson(res, 200, body)
      }

      if (method === "GET" && p === "/api/v1/host/share") {
        if (!options.share || !authToken) {
          return sendProblem(res, 501, Object.assign(new Error("sharing is unavailable"), { code: "CAPABILITY_DISABLED" }))
        }
        const shareHost = options.share.host
        const lan = shareHost !== "127.0.0.1" && shareHost !== "::1" && shareHost !== "localhost"
        const urlHost = shareHost === "0.0.0.0" || shareHost === "::" ? (firstLanAddress() ?? shareHost) : shareHost
        const url = `http://${urlHost}:${options.share.port}`
        const link = `piui://connect?url=${encodeURIComponent(url)}&token=${encodeURIComponent(authToken)}`
        const body: ShareInfo = { url, token: authToken, link, lan }
        return sendJson(res, 200, body)
      }

      if (method === "GET" && p === "/api/v1/host/registry") {
        return sendJson(res, 200, host.registry())
      }

      if (method === "GET" && p === "/api/v1/pi/registry") {
        return sendJson(res, 200, await sessions.piRegistry(scope.signal))
      }

      const piCommandMatch = p.match(/^\/api\/v1\/pi\/commands\/([^/]+)$/)
      if (piCommandMatch && method === "POST") {
        const body = await readBody(req, scope.signal, MAX_JSON_BODY_BYTES * 24)
        const name = safeDecode(piCommandMatch[1]!)
        const data = await sessions.executeGlobalCommand(name, commandParams(body), { signal: scope.signal })
        return sendJson(res, 200, { data: data ?? null })
      }

      const piSessionCommandMatch = p.match(/^\/api\/v1\/pi\/sessions\/([^/]+)\/commands\/([^/]+)$/)
      if (piSessionCommandMatch && method === "POST") {
        const body = await readBody(req, scope.signal, MAX_JSON_BODY_BYTES * 24)
        const sessionId = safeDecode(piSessionCommandMatch[1]!)
        const name = safeDecode(piSessionCommandMatch[2]!)
        const id = typeof body.id === "string" && body.id ? body.id : undefined
        const result = await sessions.executeSessionCommand(sessionId, name, commandParams(body), id, { signal: scope.signal })
        if (isSubmittedCommand(result)) {
          void result.promise.catch(() => undefined)
          return sendJson(res, 202, { command: result.record })
        }
        return sendJson(res, 200, { data: result ?? null })
      }

      const commandMatch = p.match(/^\/api\/v1\/host\/commands\/([^/]+)$/)
      if (commandMatch && method === "GET") {
        const data = await host.execute("commands.get", { id: safeDecode(commandMatch[1]!) }, { signal: scope.signal })
        return sendJson(res, 200, data ?? null)
      }
      if (commandMatch && method === "POST") {
        const body = await readBody(req, scope.signal, MAX_JSON_BODY_BYTES * 24)
        const data = await host.execute(safeDecode(commandMatch[1]!), commandParams(body) ?? {}, { signal: scope.signal })
        return sendJson(res, 200, { data: data ?? null })
      }

      const allowedMethods = allowedMethodsForPath(p)
      if (allowedMethods) {
        res.setHeader("allow", allowedMethods)
        return sendProblem(res, 405, Object.assign(new Error("method not allowed"), { code: "METHOD_NOT_ALLOWED" }))
      }
      return sendProblem(res, 404, Object.assign(new Error("not found"), { code: "NOT_FOUND" }))
    } catch (error) {
      if (scope.signal.aborted || res.destroyed || res.writableEnded) return
      const status = statusForError(error)
      return sendProblem(res, status, error)
    } finally {
      scope.cleanup()
    }
  })

  return {
    server,
    eventHub: hub,
    sessionHost: sessions,
    supervisor,
    terminals,
    dispose: async () => {
      if (disposal) return disposal
      disposal = (async () => {
        await closeHttpServer()
        await watcher.dispose()
        terminals.dispose()
        sessions.dispose()
        await supervisor.dispose()
      })()
      return disposal
    },
  }
}

function allowedMethodsForPath(pathname: string): string | undefined {
  if (pathname === "/api/v1/host/health" || pathname === "/api/v1/host/share" ||
    pathname === "/api/v1/host/registry" || pathname === "/api/v1/pi/registry") return "GET"
  if (/^\/api\/v1\/pi\/commands\/[^/]+$/.test(pathname) ||
    /^\/api\/v1\/pi\/sessions\/[^/]+\/commands\/[^/]+$/.test(pathname)) return "POST"
  if (/^\/api\/v1\/host\/commands\/[^/]+$/.test(pathname)) return "GET, POST"
  return undefined
}

export function statusForError(error: unknown): number {
  if (error instanceof PathSafetyError) {
    return error.code === "INVALID_REQUEST" ? 400 : 403
  }
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "INTERNAL"
  switch (code) {
    case "INVALID_REQUEST":
    case "STALE_CURSOR":
      return 400
    case "UNAUTHORIZED":
    case "AUTH_REQUIRED":
      return 401
    case "FORBIDDEN":
    case "PATH_OUTSIDE_WORKSPACE":
    case "SYMLINK_ESCAPE":
    case "PROJECT_TRUST_REQUIRED":
      return 403
    case "NOT_FOUND":
    case "UNKNOWN_COMMAND":
    case "SESSION_NOT_FOUND":
    case "WORKSPACE_NOT_FOUND":
    case "TERMINAL_NOT_FOUND":
      return 404
    case "TERMINAL_CURSOR_EXPIRED":
      return 409
    case "TERMINAL_EXITED":
      return 409
    case "TERMINAL_LIMIT_REACHED":
    case "TERMINAL_START_FAILED":
      return 503
    case "FILE_TOO_LARGE":
    case "GIT_OUTPUT_LIMIT":
      return 413
    case "GIT_TIMEOUT":
      return 504
    case "GIT_BASE_NOT_FOUND":
    case "EXTENSION_UI_CANCELLED":
      return 409
    case "EXTENSION_UI_TUI_ONLY":
      return 501
    case "PI_SDK_VERSION_MISMATCH":
      return 503
    case "HOST_CALL_TIMEOUT":
      return 504
    case "REGISTRY_UNAVAILABLE":
    case "DRIVER_UNAVAILABLE":
    case "WORKER_RESULT_UNKNOWN":
      return 503
    case "METHOD_NOT_ALLOWED":
      return 405
    case "SESSION_BUSY":
    case "WORKSPACE_BUSY":
    case "COMMAND_ALREADY_ACCEPTED":
    case "FILE_CONFLICT":
    case "SESSION_CONFLICT":
    case "SESSION_IDENTITY_MISMATCH":
    case "RUNTIME_REPLACED":
    case "RUNTIME_CLOSING":
    case "WORKSPACE_REPLACED":
    case "STALE_REVISION":
      return 409
    case "CAPABILITY_DISABLED":
      return 501
    default:
      return 500
  }
}
