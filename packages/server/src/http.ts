import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import {
  PI_PARITY_SDK_VERSION,
  PROTOCOL_VERSION,
  problem,
  problemFromError,
  type HealthResponse,
  type JsonObject,
} from "@piui/protocol"
import { EventHub } from "./event-hub.ts"
import { RuntimeSupervisor } from "./pi/supervisor.ts"
import { SessionHost } from "./pi/session-host.ts"
import { WorkspaceStore } from "./host/workspace-store.ts"
import { WorkspaceWatcher } from "./host/workspace-watcher.ts"
import { MAX_JSON_BODY_BYTES, requestHasAllowedOrigin, requestHasValidToken } from "./host/security.ts"
import { resolveAuthToken } from "./host/auth-token.ts"
import { PathSafetyError } from "./host/path-safety.ts"
import { HostRuntime } from "./host/command-table.ts"

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,if-match",
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    ...CORS_HEADERS,
  })
  res.end(data)
}

function sendProblem(res: ServerResponse, status: number, error: unknown) {
  const p = error && typeof error === "object" && "code" in error && "message" in error
    ? { code: String((error as { code: unknown }).code), message: String((error as { message: unknown }).message) }
    : problemFromError(error)
  sendJson(res, status, problem(p.code as Parameters<typeof problem>[0], p.message))
}

async function readBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<JsonObject> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
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

function parseUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? "127.0.0.1"
  return new URL(req.url ?? "/", `http://${host}`)
}

function invalidRequest(message: string): Error {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST" })
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
}

export interface AppServer {
  server: Server
  eventHub: EventHub
  sessionHost: SessionHost
  supervisor: RuntimeSupervisor
  dispose(): Promise<void>
}

export function createAppServer(options: CreateAppServerOptions = {}): AppServer {
  const store = new WorkspaceStore()
  const hub = options.eventHub ?? new EventHub()
  const supervisor = options.supervisor ?? new RuntimeSupervisor()
  const sessions = options.sessionHost ?? new SessionHost(supervisor, hub)
  const watcher = new WorkspaceWatcher(hub)
  const host = new HostRuntime({ store, watcher, sessions })
  const authToken = options.authToken === undefined ? resolveAuthToken() : options.authToken

  const server = createServer(async (req, res) => {
    try {
      const url = parseUrl(req)
      const method = req.method ?? "GET"
      const p = url.pathname

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
        const body: HealthResponse = {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          service: "piui-server",
          piSdkVersion: PI_PARITY_SDK_VERSION,
        }
        return sendJson(res, 200, body)
      }

      if (method === "GET" && p === "/api/v1/host/registry") {
        return sendJson(res, 200, host.registry())
      }

      if (method === "GET" && p === "/api/v1/pi/registry") {
        return sendJson(res, 200, await sessions.piRegistry())
      }

      const piCommandMatch = p.match(/^\/api\/v1\/pi\/commands\/([^/]+)$/)
      if (piCommandMatch && method === "POST") {
        const body = await readBody(req, MAX_JSON_BODY_BYTES * 24)
        const name = decodeURIComponent(piCommandMatch[1]!)
        const data = await sessions.executeGlobalCommand(name, commandParams(body))
        return sendJson(res, 200, { data: data ?? null })
      }

      const piSessionCommandMatch = p.match(/^\/api\/v1\/pi\/sessions\/([^/]+)\/commands\/([^/]+)$/)
      if (piSessionCommandMatch && method === "POST") {
        const body = await readBody(req, MAX_JSON_BODY_BYTES * 24)
        const sessionId = decodeURIComponent(piSessionCommandMatch[1]!)
        const name = decodeURIComponent(piSessionCommandMatch[2]!)
        const id = typeof body.id === "string" && body.id ? body.id : undefined
        const result = await sessions.executeSessionCommand(sessionId, name, commandParams(body), id)
        if (isSubmittedCommand(result)) {
          void result.promise.catch(() => undefined)
          return sendJson(res, 202, { command: result.record })
        }
        return sendJson(res, 200, { data: result ?? null })
      }

      const commandMatch = p.match(/^\/api\/v1\/host\/commands\/([^/]+)$/)
      if (commandMatch && method === "GET") {
        const data = await host.execute("commands.get", { id: decodeURIComponent(commandMatch[1]!) })
        return sendJson(res, 200, data ?? null)
      }
      if (commandMatch && method === "POST") {
        const body = await readBody(req, MAX_JSON_BODY_BYTES * 24)
        const data = await host.execute(decodeURIComponent(commandMatch[1]!), commandParams(body) ?? {})
        return sendJson(res, 200, { data: data ?? null })
      }

      return sendProblem(res, 404, Object.assign(new Error("not found"), { code: "NOT_FOUND" }))
    } catch (error) {
      const status = statusForError(error)
      return sendProblem(res, status, error)
    }
  })

  return {
    server,
    eventHub: hub,
    sessionHost: sessions,
    supervisor,
    dispose: async () => {
      watcher.dispose()
      await supervisor.dispose()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function statusForError(error: unknown): number {
  if (error instanceof PathSafetyError) return 403
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
      return 404
    case "FILE_TOO_LARGE":
      return 413
    case "GIT_TIMEOUT":
      return 504
    case "SESSION_BUSY":
    case "COMMAND_ALREADY_ACCEPTED":
    case "FILE_CONFLICT":
    case "SESSION_CONFLICT":
    case "STALE_REVISION":
      return 409
    case "CAPABILITY_DISABLED":
      return 501
    default:
      return 500
  }
}
