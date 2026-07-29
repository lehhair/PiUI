import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import {
  PI_PARITY_SDK_VERSION,
  PROTOCOL_VERSION,
  problem,
  problemFromError,
  type HealthResponse,
  type JsonObject,
  type WorkspaceCreateRequest,
} from "@piui/protocol"
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  listFiles,
  moveWorkspaceEntry,
  readFileContent,
  writeFileContent,
} from "./host/files.ts"
import { searchFilesByName, searchWorkspaceText } from "./host/file-search.ts"
import { getGitDiff, getGitFileDiff, getGitInfo, getGitStatus } from "./host/git.ts"
import { EventHub } from "./event-hub.ts"
import { RuntimeSupervisor } from "./pi/supervisor.ts"
import { SessionHost } from "./pi/session-host.ts"
import { WorkspaceStore } from "./host/workspace-store.ts"
import { WorkspaceWatcher } from "./host/workspace-watcher.ts"
import { MAX_JSON_BODY_BYTES, requestHasAllowedOrigin, requestHasValidToken } from "./host/security.ts"
import { resolveAuthToken } from "./host/auth-token.ts"
import { PathSafetyError } from "./host/path-safety.ts"

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
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

function pageLimit(url: URL, key: string, fallback: number, maximum: number): number {
  const value = url.searchParams.get(key)
  if (value === null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw invalidRequest(`${key} must be an integer from 1 to ${maximum}`)
  }
  return parsed
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

      if (method === "GET" && (p === "/api/v1/host/health" || p === "/health")) {
        const body: HealthResponse = {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          service: "piui-server",
          piSdkVersion: PI_PARITY_SDK_VERSION,
        }
        return sendJson(res, 200, body)
      }

      if (method === "GET" && p === "/api/v1/host/capabilities") {
        return sendJson(res, 200, {
          protocolVersion: PROTOCOL_VERSION,
          service: "piui-server",
          piSdkVersion: PI_PARITY_SDK_VERSION,
          driver: process.env.PIUI_DRIVER ?? "mock",
          eventStreams: ["server", "workspace", "session", "provider", "resources"],
          eventChannels: [
            "pi.event",
            "session.head",
            "command.updated",
            "extension.ui",
            "registry.updated",
            "provider.auth",
            "packages.progress",
            "sessions.updated",
            "resources.updated",
            "workspace.files",
            "workspace.git",
          ],
        })
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
        const record = sessions.getCommand(decodeURIComponent(commandMatch[1]!))
        if (!record) return sendProblem(res, 404, Object.assign(new Error("command not found"), { code: "NOT_FOUND" }))
        return sendJson(res, 200, { command: record })
      }

      if (p === "/api/v1/host/workspaces") {
        if (method === "GET") return sendJson(res, 200, { workspaces: store.list() })
        if (method === "POST") {
          const body = await readBody(req)
          const request = body as unknown as WorkspaceCreateRequest
          if (typeof request.rootPath !== "string" || !request.rootPath) {
            throw invalidRequest("body.rootPath must be a non-empty string")
          }
          const record = store.resolve(request.rootPath, request.displayName)
          return sendJson(res, 201, {
            workspace: {
              path: record.canonicalRoot,
              displayName: record.displayName,
              createdAt: record.createdAt,
              lastOpenedAt: record.lastOpenedAt,
            },
          })
        }
        res.setHeader("allow", "GET,POST")
        return sendProblem(res, 405, Object.assign(new Error("method not allowed"), { code: "METHOD_NOT_ALLOWED" }))
      }

      const workspaceMatch = p.match(/^\/api\/v1\/host\/workspaces\/([^/]+)(\/(.*))?$/)
      if (workspaceMatch) {
        const workspacePath = decodeURIComponent(workspaceMatch[1]!)
        const sub = workspaceMatch[3] ?? ""
        const workspace = store.find(workspacePath)
        if (!workspace) {
          return sendProblem(res, 404, Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" }))
        }

        if (!sub && method === "DELETE") {
          watcher.unwatch(workspace)
          store.remove(workspace.canonicalRoot)
          return sendJson(res, 200, { ok: true })
        }
        if (sub === "watch" && method === "POST") {
          watcher.watch(workspace)
          return sendJson(res, 200, { ok: true })
        }
        if (sub === "files/list" && method === "GET") {
          const data = await listFiles(workspace, url.searchParams.get("path") ?? "", {
            limit: pageLimit(url, "limit", 500, 5000),
            cursor: url.searchParams.get("cursor") ?? undefined,
          })
          return sendJson(res, 200, data)
        }
        if (sub === "files/read" && method === "GET") {
          const relative = url.searchParams.get("path")
          if (!relative) throw invalidRequest("path query is required")
          return sendJson(res, 200, await readFileContent(workspace, relative))
        }
        if (sub === "files/write" && method === "PUT") {
          const body = await readBody(req, MAX_JSON_BODY_BYTES * 8)
          const relative = url.searchParams.get("path")
          if (!relative) throw invalidRequest("path query is required")
          if (typeof body.content !== "string") throw invalidRequest("body.content must be a string")
          return sendJson(res, 200, await writeFileContent(workspace, relative, body.content, {
            ifMatch: typeof body.ifMatch === "string" ? body.ifMatch : undefined,
            encoding: body.encoding === "base64" ? "base64" : "utf-8",
          }))
        }
        if (sub === "files/create" && method === "POST") {
          const body = await readBody(req)
          const relative = typeof body.path === "string" ? body.path : undefined
          if (!relative) throw invalidRequest("body.path is required")
          const type = body.type === "directory" ? "directory" : "file"
          return sendJson(res, 201, await createWorkspaceEntry(workspace, relative, type, {
            content: typeof body.content === "string" ? body.content : undefined,
            overwrite: body.overwrite === true,
          }))
        }
        if (sub === "files/move" && method === "POST") {
          const body = await readBody(req)
          if (typeof body.from !== "string" || typeof body.to !== "string") {
            throw invalidRequest("body.from and body.to are required")
          }
          return sendJson(res, 200, await moveWorkspaceEntry(workspace, body.from, body.to, body.overwrite === true))
        }
        if (sub === "files/delete" && method === "POST") {
          const body = await readBody(req)
          const relative = typeof body.path === "string" ? body.path : undefined
          if (!relative) throw invalidRequest("body.path is required")
          await deleteWorkspaceEntry(workspace, relative, body.recursive === true)
          return sendJson(res, 200, { ok: true })
        }
        if (sub === "files/search-name" && method === "GET") {
          const query = url.searchParams.get("q") ?? ""
          return sendJson(res, 200, await searchFilesByName(workspace, query, {
            limit: pageLimit(url, "limit", 100, 1000),
          }))
        }
        if (sub === "files/search-text" && method === "GET") {
          const query = url.searchParams.get("q") ?? ""
          return sendJson(res, 200, await searchWorkspaceText(workspace, query, {
            limit: pageLimit(url, "limit", 100, 1000),
          }))
        }
        if (sub === "git/info" && method === "GET") {
          return sendJson(res, 200, await getGitInfo(workspace.canonicalRoot))
        }
        if (sub === "git/status" && method === "GET") {
          return sendJson(res, 200, await getGitStatus(workspace.canonicalRoot))
        }
        if (sub === "git/diff" && method === "GET") {
          const mode = url.searchParams.get("mode") ?? "git"
          return sendJson(res, 200, await getGitDiff(workspace.canonicalRoot, mode as "git" | "branch" | "staged" | "unstaged"))
        }
        if (sub === "git/file-diff" && method === "GET") {
          const relative = url.searchParams.get("path")
          if (!relative) throw invalidRequest("path query is required")
          const mode = url.searchParams.get("mode") ?? "git"
          return sendJson(res, 200, await getGitFileDiff(workspace.canonicalRoot, mode as "git" | "branch" | "staged" | "unstaged", relative))
        }
        return sendProblem(res, 404, Object.assign(new Error("not found"), { code: "NOT_FOUND" }))
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
    case "SESSION_NOT_FOUND":
    case "WORKSPACE_NOT_FOUND":
      return 404
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
