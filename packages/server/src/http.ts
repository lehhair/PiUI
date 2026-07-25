import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  PROTOCOL_VERSION,
  problem,
  type HealthResponseV1,
  type WorkspaceCreateRequestV1,
} from "@piui/protocol"
import { listFiles, readFileText, writeFileText } from "./files.ts"
import { searchFilesByName } from "./file-search.ts"
import { PathSafetyError } from "./path-safety.ts"
import { SessionRegistry, type AppSession } from "./session-registry.ts"
import { WorkspaceStore } from "./workspace-store.ts"
import { eventHub } from "./event-hub.ts"
import { getGitDiff, getGitInfo, getGitStatus } from "./git.ts"
import { getDriverMode } from "@piui/pi-worker"
import { listModelsForUi } from "./models.ts"
import { MAX_JSON_BODY_BYTES, requestHasAllowedOrigin, requestHasValidToken } from "./security.ts"
import { SessionExecutor } from "./session-executor.ts"
import { randomUUID } from "node:crypto"

const store = new WorkspaceStore()
const sessions = new SessionRegistry(store)
const sessionExecutor = new SessionExecutor(command => {
  eventHub.publish({
    type: "command.updated",
    sessionId: command.sessionId,
    payload: command,
  })
})
let defaultWorkspaceId: string | null = null

async function ensureDefaultWorkspace(): Promise<string> {
  if (defaultWorkspaceId && store.get(defaultWorkspaceId)) return defaultWorkspaceId
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const root = mkdtempSync(path.join(tmpdir(), "piui-default-"))
  const rec = store.register(root, "piui-default")
  defaultWorkspaceId = rec.id
  return rec.id
}

function sessionSummary(s: AppSession) {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
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

function sendProblem(
  res: ServerResponse,
  status: number,
  code: Parameters<typeof problem>[0],
  message: string,
) {
  sendJson(res, status, problem(code, message))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const chunk = c as Buffer
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) throw Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function parseUrl(req: IncomingMessage) {
  const host = req.headers.host ?? "127.0.0.1"
  return new URL(req.url ?? "/", `http://${host}`)
}

export function createAppServer() {
  const authToken = process.env.PIUI_AUTH_TOKEN
  return createServer(async (req, res) => {
    try {
      const url = parseUrl(req)
      const method = req.method ?? "GET"
      const p = url.pathname

      if (!requestHasAllowedOrigin(req)) {
        return sendProblem(res, 403, "INVALID_REQUEST", "origin not allowed")
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
        return sendProblem(res, 401, "INVALID_REQUEST", "missing or invalid authorization token")
      }

      const commandStatus = p.match(/^\/api\/v1\/commands\/([^/]+)$/)
      if (method === "GET" && commandStatus) {
        const command = sessionExecutor.get(decodeURIComponent(commandStatus[1]))
        if (!command) return sendProblem(res, 404, "INVALID_REQUEST", "command not found")
        return sendJson(res, 200, { command })
      }

      if (method === "GET" && (p === "/api/v1/health" || p === "/health")) {
        const body = {
          ok: true as const,
          protocolVersion: PROTOCOL_VERSION,
          service: "piui-server" as const,
          phase: 1,
          driver: sessions.getDriver(),
        }
        return sendJson(res, 200, { ...body, capabilities: { pty: false, share: false, fork: false, undo: false, fileWrite: true, gitDiff: true } })
      }

      // Dev helper: one-shot mock chat (no LLM). Creates temp workspace + seeded session.
      if (method === "POST" && p === "/api/v1/dev/mock-chat") {
        const workspaceId = await ensureDefaultWorkspace()
        // seedMock only applies in mock driver; real pi starts empty
        const s = await sessions.create(workspaceId, {
          title: getDriverMode() === "mock" ? "Mock chat" : "New chat",
          seedMock: getDriverMode() === "mock",
        })
        const rec = store.get(workspaceId)!
        return sendJson(res, 201, {
          workspace: {
            id: rec.id,
            displayName: rec.displayName,
            createdAt: rec.createdAt,
            lastOpenedAt: rec.lastOpenedAt,
          },
          snapshot: sessions.snapshot(s),
          driver: sessions.getDriver(),
        })
      }

      if (method === "GET" && p === "/api/v1/drivers/pi/models") {
        return sendJson(res, 200, await listModelsForUi())
      }

      if (method === "GET" && p === "/api/v1/sessions") {
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined
        const list = (await sessions.list(workspaceId))
          .slice()
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map(sessionSummary)
        return sendJson(res, 200, { sessions: list })
      }

      if (method === "POST" && p === "/api/v1/sessions") {
        const raw = await readBody(req)
        let body: { workspaceId?: string; title?: string; seedMock?: boolean }
        try {
          body = JSON.parse(raw || "{}") as { workspaceId?: string; title?: string; seedMock?: boolean }
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        try {
          const workspaceId = body.workspaceId || (await ensureDefaultWorkspace())
          const s = await sessions.create(workspaceId, {
            title: body.title,
            seedMock: body.seedMock === true,
          })
          return sendJson(res, 201, {
            session: sessionSummary(s),
            snapshot: sessions.snapshot(s),
            driver: sessions.getDriver(),
          })
        } catch (e) {
          const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : ""
          if (code === "WORKSPACE_NOT_FOUND") {
            return sendProblem(res, 404, "WORKSPACE_NOT_FOUND", "workspace not found")
          }
          return sendProblem(res, 400, "INVALID_REQUEST", e instanceof Error ? e.message : String(e))
        }
      }

      const sessionSnap = p.match(/^\/api\/v1\/sessions\/([^/]+)\/snapshot$/)
      if (method === "GET" && sessionSnap) {
        const id = decodeURIComponent(sessionSnap[1])
        const s = await sessions.find(id)
        if (!s) return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
        const attached = await sessions.attach(id)
        return sendJson(res, 200, sessions.snapshot(attached))
      }

      const sessionOnly = p.match(/^\/api\/v1\/sessions\/([^/]+)$/)
      if (method === "DELETE" && sessionOnly) {
        const id = decodeURIComponent(sessionOnly[1])
        if (!await sessions.find(id)) return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
        await sessions.delete(id)
        return sendJson(res, 200, { ok: true, id })
      }

      const sessionPrompt = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/prompt$/)
      if (method === "POST" && sessionPrompt) {
        const id = decodeURIComponent(sessionPrompt[1])
        const raw = await readBody(req)
        let body: {
          text?: string
          stream?: boolean
          model?: { provider?: string; id?: string }
          deliverAs?: "steer" | "followUp"
          commandId?: string
        }
        try {
          body = JSON.parse(raw || "{}") as {
            text?: string
            stream?: boolean
            model?: { provider?: string; id?: string }
            deliverAs?: "steer" | "followUp"
            commandId?: string
          }
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        try {
          // stream defaults off for tests/speed; client passes stream:true for UI
          const stream = body.stream === true
          const commandId = body.commandId || req.headers["x-command-id"]?.toString() || randomUUID()
          const submitted = sessionExecutor.submit(id, commandId, "prompt", () => sessions.prompt(id, body.text ?? "", {
              stream,
              model: body.model,
              deliverAs: body.deliverAs,
              onTick: sess => {
                eventHub.publish({
                  type: "session.snapshot",
                  sessionId: sess.id,
                  workspaceId: sess.workspaceId,
                  payload: sessions.snapshot(sess),
                })
              },
            }))
          const s = await submitted.promise
          eventHub.publish({
            type: "session.updated",
            sessionId: s.id,
            workspaceId: s.workspaceId,
            payload: sessionSummary(s),
          })
          return sendJson(res, 200, {
            commandId,
            accepted: true,
            reused: submitted.reused,
            command: submitted.record,
            snapshot: sessions.snapshot(s),
          })
        } catch (e) {
          const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : ""
          if (code === "SESSION_NOT_FOUND") {
            return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
          }
          return sendProblem(res, 400, "INVALID_REQUEST", e instanceof Error ? e.message : String(e))
        }
      }

      const sessionAbort = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/abort$/)
      if (method === "POST" && sessionAbort) {
        const id = decodeURIComponent(sessionAbort[1])
        const raw = await readBody(req)
        let body: { commandId?: string } = {}
        try { body = JSON.parse(raw || "{}") as { commandId?: string } } catch { /* empty ok */ }
        const commandId = body.commandId || req.headers["x-command-id"]?.toString() || randomUUID()
        const submitted = sessionExecutor.submitControl(id, commandId, "abort", () => sessions.abort(id))
        const s = await submitted.promise
        if (!s) return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
        return sendJson(res, 200, {
          commandId,
          accepted: true,
          reused: submitted.reused,
          command: submitted.record,
          snapshot: sessions.snapshot(s),
        })
      }

      const sessionSetModel = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/set-model$/)
      if (method === "POST" && sessionSetModel) {
        const id = decodeURIComponent(sessionSetModel[1])
        const raw = await readBody(req)
        let body: { provider?: string; id?: string }
        try {
          body = JSON.parse(raw || "{}") as { provider?: string; id?: string }
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (!body.provider || !body.id) {
          return sendProblem(res, 400, "INVALID_REQUEST", "provider and id required")
        }
        try {
          const s = await sessions.setModel(id, body.provider, body.id)
          return sendJson(res, 200, { snapshot: sessions.snapshot(s) })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionThinking = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/set-thinking-level$/)
      if (method === "POST" && sessionThinking) {
        const id = decodeURIComponent(sessionThinking[1])
        const raw = await readBody(req)
        let body: { level?: string }
        try {
          body = JSON.parse(raw || "{}") as { level?: string }
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (!body.level) return sendProblem(res, 400, "INVALID_REQUEST", "level required")
        try {
          const s = await sessions.setThinkingLevel(id, body.level)
          return sendJson(res, 200, { snapshot: sessions.snapshot(s) })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionCompact = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/compact$/)
      if (method === "POST" && sessionCompact) {
        const id = decodeURIComponent(sessionCompact[1])
        const raw = await readBody(req)
        let body: { instructions?: string; commandId?: string } = {}
        try {
          body = JSON.parse(raw || "{}") as { instructions?: string; commandId?: string }
        } catch {
          /* empty ok */
        }
        try {
          const commandId = body.commandId || req.headers["x-command-id"]?.toString() || randomUUID()
          const submitted = sessionExecutor.submit(id, commandId, "compact", () => sessions.compact(id, body.instructions))
          const s = await submitted.promise
          eventHub.publish({
            type: "session.snapshot",
            sessionId: s.id,
            workspaceId: s.workspaceId,
            payload: sessions.snapshot(s),
          })
          return sendJson(res, 200, {
            commandId,
            reused: submitted.reused,
            command: submitted.record,
            snapshot: sessions.snapshot(s),
          })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionSkills = p.match(/^\/api\/v1\/sessions\/([^/]+)\/pi\/skills$/)
      if (method === "GET" && sessionSkills) {
        const id = decodeURIComponent(sessionSkills[1])
        try {
          return sendJson(res, 200, { skills: await sessions.listSkills(id) })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionCommands = p.match(/^\/api\/v1\/sessions\/([^/]+)\/pi\/commands$/)
      if (method === "GET" && sessionCommands) {
        const id = decodeURIComponent(sessionCommands[1])
        try {
          return sendJson(res, 200, { commands: await sessions.listCommands(id) })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      if (method === "GET" && p === "/api/v1/workspaces") {
        return sendJson(res, 200, { workspaces: store.list() })
      }

      if (method === "GET" && p === "/api/v1/workspaces/default") {
        const id = await ensureDefaultWorkspace()
        const rec = store.get(id)!
        return sendJson(res, 200, {
          workspace: {
            id: rec.id,
            displayName: rec.displayName,
            createdAt: rec.createdAt,
            lastOpenedAt: rec.lastOpenedAt,
          },
        })
      }

      if (method === "POST" && p === "/api/v1/workspaces") {
        const raw = await readBody(req)
        let body: WorkspaceCreateRequestV1
        try {
          body = JSON.parse(raw || "{}") as WorkspaceCreateRequestV1
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (!body.rootPath || typeof body.rootPath !== "string") {
          return sendProblem(res, 400, "INVALID_REQUEST", "rootPath required")
        }
        try {
          const rec = store.register(body.rootPath, body.displayName)
          return sendJson(res, 201, {
            workspace: {
              id: rec.id,
              displayName: rec.displayName,
              createdAt: rec.createdAt,
              lastOpenedAt: rec.lastOpenedAt,
            },
          })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return sendProblem(res, 400, "INVALID_REQUEST", msg)
        }
      }

      const wsMatch = p.match(/^\/api\/v1\/workspaces\/([^/]+)(?:\/(.*))?$/)
      if (wsMatch) {
        const wsId = decodeURIComponent(wsMatch[1])
        const rest = wsMatch[2] ?? ""
        const ws = store.get(wsId)
        if (!ws) return sendProblem(res, 404, "WORKSPACE_NOT_FOUND", "workspace not found")

        if (method === "GET" && rest === "") {
          return sendJson(res, 200, {
            workspace: {
              id: ws.id,
              displayName: ws.displayName,
              createdAt: ws.createdAt,
              lastOpenedAt: ws.lastOpenedAt,
            },
          })
        }

        if (method === "GET" && rest === "files") {
          const rel = url.searchParams.get("path") ?? ""
          try {
            return sendJson(res, 200, listFiles(ws, rel))
          } catch (e) {
            return handlePathError(res, e)
          }
        }

        if (method === "GET" && rest === "file") {
          const rel = url.searchParams.get("path") ?? ""
          if (!rel) return sendProblem(res, 400, "INVALID_REQUEST", "path query required")
          try {
            return sendJson(res, 200, readFileText(ws, rel))
          } catch (e) {
            return handlePathError(res, e)
          }
        }

        if (method === "PUT" && rest === "file") {
          const rel = url.searchParams.get("path") ?? ""
          if (!rel) return sendProblem(res, 400, "INVALID_REQUEST", "path query required")
          const raw = await readBody(req)
          let body: { content?: string; ifMatch?: string }
          try {
            body = JSON.parse(raw || "{}") as { content?: string; ifMatch?: string }
          } catch {
            return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
          }
          if (typeof body.content !== "string") {
            return sendProblem(res, 400, "INVALID_REQUEST", "content required")
          }
          try {
            const ifMatch = body.ifMatch ?? (req.headers["if-match"] as string | undefined)
            return sendJson(res, 200, writeFileText(ws, rel, body.content, { ifMatch }))
          } catch (e) {
            if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "STALE_REVISION") {
              return sendProblem(res, 409, "STALE_REVISION", e instanceof Error ? e.message : String(e))
            }
            return handlePathError(res, e)
          }
        }

        if (method === "GET" && rest === "search/files") {
          const q = url.searchParams.get("q") ?? ""
          const type = url.searchParams.get("type")
          const limit = Number(url.searchParams.get("limit") ?? 50)
          try {
            const paths = searchFilesByName(ws, q, {
              type: type === "directory" || type === "file" ? type : undefined,
              limit: Number.isFinite(limit) ? limit : 50,
            })
            return sendJson(res, 200, { query: q, paths })
          } catch (e) {
            return handlePathError(res, e)
          }
        }

        if (method === "GET" && rest === "git/status") {
          try {
            return sendJson(res, 200, await getGitStatus(ws.canonicalRoot))
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return sendProblem(res, 500, "INTERNAL", msg)
          }
        }

        if (method === "GET" && rest === "git/info") {
          try {
            return sendJson(res, 200, await getGitInfo(ws.canonicalRoot))
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return sendProblem(res, 500, "INTERNAL", msg)
          }
        }

        if (method === "GET" && rest === "git/diff") {
          const mode = url.searchParams.get("mode") === "branch" ? "branch" : "git"
          try {
            return sendJson(res, 200, await getGitDiff(ws.canonicalRoot, mode))
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return sendProblem(res, 500, "INTERNAL", msg)
          }
        }
      }

      return sendProblem(res, 404, "NOT_FOUND", "not found")
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "BODY_TOO_LARGE") {
        return sendProblem(res, 413, "INVALID_REQUEST", "request body too large")
      }
      const msg = e instanceof Error ? e.message : String(e)
      return sendProblem(res, 500, "INTERNAL", msg)
    }
  })
}

function handleSessionCmdError(res: ServerResponse, e: unknown) {
  const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : ""
  if (code === "SESSION_NOT_FOUND") {
    return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
  }
  return sendProblem(res, 400, "INVALID_REQUEST", e instanceof Error ? e.message : String(e))
}

function handlePathError(res: ServerResponse, e: unknown) {
  if (e instanceof PathSafetyError) {
    const status =
      e.code === "INVALID_REQUEST" ? 400 : e.code === "SYMLINK_ESCAPE" ? 403 : 403
    return sendProblem(res, status, e.code, e.message)
  }
  if (e && typeof e === "object" && "code" in e) {
    const code = String((e as { code: string }).code)
    if (code === "FILE_TOO_LARGE") {
      return sendProblem(res, 413, "FILE_TOO_LARGE", e instanceof Error ? e.message : String(e))
    }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return sendProblem(res, 400, "INVALID_REQUEST", msg)
}

export { store as workspaceStoreForTests }
