import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  PROTOCOL_VERSION,
  problem,
  type HealthResponseV1,
  type WorkspaceCreateRequestV1,
} from "@piui/protocol"
import { listFiles, readFileText } from "./files.ts"
import { PathSafetyError } from "./path-safety.ts"
import { SessionRegistry } from "./session-registry.ts"
import { WorkspaceStore } from "./workspace-store.ts"

const store = new WorkspaceStore()
const sessions = new SessionRegistry(store)

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
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
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

function parseUrl(req: IncomingMessage) {
  const host = req.headers.host ?? "127.0.0.1"
  return new URL(req.url ?? "/", `http://${host}`)
}

export function createAppServer() {
  return createServer(async (req, res) => {
    try {
      const url = parseUrl(req)
      const method = req.method ?? "GET"
      const p = url.pathname

      if (method === "GET" && (p === "/api/v1/health" || p === "/health")) {
        const body: HealthResponseV1 = {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          service: "piui-server",
          phase: 1,
        }
        return sendJson(res, 200, body)
      }

      if (method === "GET" && p === "/api/v1/sessions") {
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined
        const list = sessions.list(workspaceId).map(s => ({
          id: s.id,
          workspaceId: s.workspaceId,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        }))
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
        if (!body.workspaceId) {
          return sendProblem(res, 400, "INVALID_REQUEST", "workspaceId required")
        }
        try {
          const s = sessions.create(body.workspaceId, {
            title: body.title,
            seedMock: body.seedMock,
          })
          return sendJson(res, 201, { session: sessions.snapshot(s).session, snapshot: sessions.snapshot(s) })
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
        const s = sessions.get(decodeURIComponent(sessionSnap[1]))
        if (!s) return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
        return sendJson(res, 200, sessions.snapshot(s))
      }

      if (method === "GET" && p === "/api/v1/workspaces") {
        return sendJson(res, 200, { workspaces: store.list() })
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
      }

      return sendProblem(res, 404, "NOT_FOUND", "not found")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return sendProblem(res, 500, "INTERNAL", msg)
    }
  })
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
      return sendProblem(res, 413, "FILE_TOO_LARGE", (e as Error).message)
    }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return sendProblem(res, 400, "INVALID_REQUEST", msg)
}

export { store as workspaceStoreForTests }
