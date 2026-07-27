import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  PROTOCOL_VERSION,
  problem,
  type CommandRequestV2,
  type CustomMessageContentV1,
  type ExtensionUiDialogResponseV1,
  type HealthResponseV1,
  type SessionAttachmentV2,
  type WorkspaceCreateRequestV1,
} from "@piui/protocol"
import { listFiles, readFileText, writeFileText } from "./files.ts"
import { searchFilesByName, searchWorkspaceText } from "./file-search.ts"
import { PathSafetyError } from "./path-safety.ts"
import {
  SessionRegistry,
  type AppSession,
  type PiSessionBackend,
  type SessionRegistryOptions,
} from "./session-registry.ts"
import { WorkspaceStore, type WorkspaceRecord } from "./workspace-store.ts"
import { bindEventHub, EventHub } from "./event-hub.ts"
import { getGitDiff, getGitInfo, getGitStatus } from "./git.ts"
import { getDriverMode, type DriverMode } from "@piui/pi-worker"
import { listModelsForUi } from "./models.ts"
import { MAX_JSON_BODY_BYTES, MAX_PROMPT_BODY_BYTES, requestHasAllowedOrigin, requestHasValidToken } from "./security.ts"
import { resolveAuthToken } from "./auth-token.ts"
import { SessionExecutor } from "./session-executor.ts"
import { randomUUID } from "node:crypto"
import { createProtocolHandshakeV2 } from "./protocol-v2.ts"

function sessionSummary(
  s: AppSession,
  state?: ReturnType<SessionRegistry["snapshot"]>["session"]["state"],
) {
  return {
    id: s.id,
    directory: s.cwd,
    state,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-command-id,if-match",
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

async function readBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const chunk = c as Buffer
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function invalidRequest(message: string): Error & { code: "INVALID_REQUEST" } {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST" as const })
}

async function readCommandBody<T extends object = Record<string, never>>(
  req: IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<T & { commandId?: string }> {
  const raw = await readBody(req, maxBytes)
  let body: unknown
  try {
    body = JSON.parse(raw || "{}")
  } catch {
    throw invalidRequest("invalid json")
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidRequest("json body must be an object")
  }
  return body as T & { commandId?: string }
}

function resolveCommandId(req: IncomingMessage, body: { commandId?: unknown } = {}): string {
  const bodyId = body.commandId
  const headerValue = req.headers["x-command-id"]
  const headerId = Array.isArray(headerValue) ? headerValue[0] : headerValue
  const candidate = bodyId ?? headerId
  if (candidate === undefined) return randomUUID()
  if (typeof candidate !== "string" || !candidate.trim() || candidate.length > 256) {
    throw invalidRequest("commandId must be a non-empty string of at most 256 characters")
  }
  return candidate
}

function sendMethodNotAllowed(res: ServerResponse, allowed: string) {
  res.setHeader("allow", allowed)
  return sendProblem(res, 405, "METHOD_NOT_ALLOWED", "method not allowed")
}

function parseUrl(req: IncomingMessage) {
  const host = req.headers.host ?? "127.0.0.1"
  return new URL(req.url ?? "/", `http://${host}`)
}

function redactAttachmentData(attachments: SessionAttachmentV2[] | undefined): SessionAttachmentV2[] | undefined {
  return attachments?.map(attachment => attachment.type === "image"
    ? { ...attachment, data: `<redacted:${attachment.data.length}>` }
    : attachment)
}

export interface CreateAppServerOptions {
  driver?: DriverMode
  piBackend?: PiSessionBackend
  eventHub?: EventHub
  sessionRegistry?: SessionRegistryOptions
  /**
   * Defaults to the persisted local token. Pass `null` to serve without
   * authentication, which only tests should do.
   */
  authToken?: string | null
}

/** Ignores unset and malformed values so a bad env var falls back to defaults. */
function positiveEnvMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export function createAppServer(options: CreateAppServerOptions = {}) {
  const store = new WorkspaceStore()
  const eventHub = options.eventHub ?? new EventHub()
  const sessionExecutor = new SessionExecutor(command => {
    eventHub.publish({
      type: "command.updated",
      sessionId: command.request.sessionId,
      payload: command,
    })
  })
  const sessions = new SessionRegistry(
    store,
    options.driver ?? getDriverMode(),
    options.piBackend,
    eventHub,
    sessionId => sessionExecutor.markRuntimeCrashed(sessionId),
    options.sessionRegistry ?? {
      idleRuntimeTimeoutMs: positiveEnvMs(process.env.PIUI_IDLE_RUNTIME_TIMEOUT_MS),
      idleSweepIntervalMs: positiveEnvMs(process.env.PIUI_IDLE_SWEEP_INTERVAL_MS),
    },
  )
  const publishSessionSnapshot = (session: AppSession) => {
    eventHub.publish({
      type: "session.snapshot",
      sessionId: session.id,
      workspacePath: session.cwd,
      reason: "command",
      payload: sessions.snapshot(session),
    })
  }
  const publishSessionUpdated = (session: AppSession) => {
    eventHub.publish({
      type: "session.updated",
      sessionId: session.id,
      workspacePath: session.cwd,
      payload: sessionSummary(session, sessions.snapshot(session).session.state),
    })
  }
  let defaultWorkspacePath: string | null = null
  const ensureDefaultWorkspace = async (): Promise<string> => {
    if (defaultWorkspacePath && store.find(defaultWorkspacePath)) return defaultWorkspacePath
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const path = await import("node:path")
    const root = mkdtempSync(path.join(tmpdir(), "piui-default-"))
    const rec = store.resolve(root, "piui-default")
    defaultWorkspacePath = rec.canonicalRoot
    return rec.canonicalRoot
  }
  const authToken = options.authToken === undefined ? resolveAuthToken() : options.authToken
  const server = createServer(async (req, res) => {
    try {
      const url = parseUrl(req)
      const method = req.method ?? "GET"
      const p = url.pathname

      if (!requestHasAllowedOrigin(req)) {
        return sendProblem(res, 403, "FORBIDDEN", "origin not allowed")
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
        return sendProblem(res, 401, "UNAUTHORIZED", "missing or invalid authorization token")
      }

      const commandStatus = p.match(/^\/api\/v1\/commands\/([^/]+)$/)
      if (method === "GET" && commandStatus) {
        const command = sessionExecutor.get(decodeURIComponent(commandStatus[1]))
        if (!command) return sendProblem(res, 404, "NOT_FOUND", "command not found")
        return sendJson(res, 200, { command })
      }
      if (commandStatus) return sendMethodNotAllowed(res, "GET")

      if (method === "GET" && (p === "/api/v1/health" || p === "/health")) {
        const body = {
          ok: true as const,
          protocolVersion: PROTOCOL_VERSION,
          service: "piui-server" as const,
          phase: 1,
          driver: sessions.getDriver(),
          protocolV2: createProtocolHandshakeV2(sessions.getDriver()),
        }
        return sendJson(res, 200, {
          ...body,
          capabilities: {
            pty: false,
            share: false,
            fork: true,
            undo: false,
            fileWrite: true,
            gitDiff: true,
            sessionRename: true,
            sessionArchive: false,
            mcp: false,
            worktree: false,
            config: false,
          },
        })
      }

      // Dev helper: one-shot mock chat (no LLM). Creates temp workspace + seeded session.
      if (method === "POST" && p === "/api/v1/dev/mock-chat") {
        const workspacePath = await ensureDefaultWorkspace()
        // seedMock only applies in mock driver; real pi starts empty
        const s = await sessions.create(workspacePath, {
          title: sessions.getDriver() === "mock" ? "Mock chat" : "New chat",
          seedMock: sessions.getDriver() === "mock",
        })
        publishSessionUpdated(s)
        const rec = store.resolve(workspacePath)
        return sendJson(res, 201, {
          workspace: {
            path: rec.canonicalRoot,
            displayName: rec.displayName,
            createdAt: rec.createdAt,
            lastOpenedAt: rec.lastOpenedAt,
          },
          snapshot: sessions.snapshot(s),
          driver: sessions.getDriver(),
        })
      }

      if (method === "GET" && p === "/api/v1/drivers/pi/models") {
        return sendJson(res, 200, await listModelsForUi(sessions.getDriver(), () => sessions.listModels()))
      }

      if (method === "GET" && p === "/api/v1/providers") {
        try {
          return sendJson(res, 200, { providers: await sessions.listProviders() })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      if (method === "GET" && p === "/api/v1/model-runtime") {
        try {
          return sendJson(res, 200, await sessions.inspectModelRuntime())
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      if (method === "POST" && (p === "/api/v1/model-runtime/reload" || p === "/api/v1/model-runtime/refresh")) {
        try {
          if (p.endsWith("/reload")) {
            await sessions.reloadModelRuntime()
            return sendJson(res, 200, { reloaded: true })
          }
          const raw = await readBody(req)
          let options: Record<string, unknown>
          try {
            options = JSON.parse(raw || "{}") as Record<string, unknown>
          } catch {
            return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
          }
          return sendJson(res, 200, { result: await sessions.refreshModelRuntime(options) })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const runtimeApiKey = p.match(/^\/api\/v1\/providers\/([^/]+)\/runtime-api-key$/)
      if (runtimeApiKey && (method === "PUT" || method === "DELETE")) {
        const providerId = decodeURIComponent(runtimeApiKey[1])
        try {
          if (method === "DELETE") {
            await sessions.removeRuntimeApiKey(providerId)
            res.writeHead(204)
            return res.end()
          }
          const raw = await readBody(req)
          let body: { apiKey?: string }
          try {
            body = JSON.parse(raw || "{}") as typeof body
          } catch {
            return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
          }
          if (!body.apiKey) return sendProblem(res, 400, "INVALID_REQUEST", "apiKey required")
          await sessions.setRuntimeApiKey(providerId, body.apiKey)
          return sendJson(res, 200, { configured: true })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const providerAuthFlow = p.match(/^\/api\/v1\/providers\/([^/]+)\/auth-flows$/)
      if (method === "POST" && providerAuthFlow) {
        const providerId = decodeURIComponent(providerAuthFlow[1])
        const raw = await readBody(req)
        let body: { type?: "api_key" | "oauth" }
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (body.type !== "api_key" && body.type !== "oauth") {
          return sendProblem(res, 400, "INVALID_REQUEST", "auth type must be api_key or oauth")
        }
        try {
          return sendJson(res, 202, { flowId: await sessions.startProviderAuth(providerId, body.type) })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const authPromptResponse = p.match(/^\/api\/v1\/auth-flows\/([^/]+)\/prompts\/([^/]+)\/response$/)
      if (method === "POST" && authPromptResponse) {
        const flowId = decodeURIComponent(authPromptResponse[1])
        const promptId = decodeURIComponent(authPromptResponse[2])
        const raw = await readBody(req)
        let body: { value?: string }
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (typeof body.value !== "string") return sendProblem(res, 400, "INVALID_REQUEST", "value required")
        try {
          await sessions.respondProviderAuth(flowId, promptId, body.value)
          return sendJson(res, 200, { accepted: true })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const authFlowOnly = p.match(/^\/api\/v1\/auth-flows\/([^/]+)$/)
      if (method === "DELETE" && authFlowOnly) {
        try {
          await sessions.cancelProviderAuth(decodeURIComponent(authFlowOnly[1]))
          res.writeHead(204)
          return res.end()
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const providerAuthOnly = p.match(/^\/api\/v1\/providers\/([^/]+)\/auth$/)
      if (method === "DELETE" && providerAuthOnly) {
        try {
          await sessions.logoutProvider(decodeURIComponent(providerAuthOnly[1]))
          res.writeHead(204)
          return res.end()
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionProviders = p.match(/^\/api\/v1\/sessions\/([^/]+)\/providers$/)
      if (method === "GET" && sessionProviders) {
        try {
          return sendJson(res, 200, {
            providers: await sessions.listSessionProviders(decodeURIComponent(sessionProviders[1])),
          })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionProviderFlow = p.match(/^\/api\/v1\/sessions\/([^/]+)\/providers\/([^/]+)\/auth-flows$/)
      if (method === "POST" && sessionProviderFlow) {
        const raw = await readBody(req)
        let body: { type?: "api_key" | "oauth" }
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (body.type !== "api_key" && body.type !== "oauth") {
          return sendProblem(res, 400, "INVALID_REQUEST", "auth type must be api_key or oauth")
        }
        try {
          return sendJson(res, 202, { flowId: await sessions.startSessionProviderAuth(
            decodeURIComponent(sessionProviderFlow[1]),
            decodeURIComponent(sessionProviderFlow[2]),
            body.type,
          ) })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionAuthPrompt = p.match(
        /^\/api\/v1\/sessions\/([^/]+)\/auth-flows\/([^/]+)\/prompts\/([^/]+)\/response$/,
      )
      if (method === "POST" && sessionAuthPrompt) {
        const raw = await readBody(req)
        let body: { value?: string }
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (typeof body.value !== "string") return sendProblem(res, 400, "INVALID_REQUEST", "value required")
        try {
          await sessions.respondSessionProviderAuth(
            decodeURIComponent(sessionAuthPrompt[1]),
            decodeURIComponent(sessionAuthPrompt[2]),
            decodeURIComponent(sessionAuthPrompt[3]),
            body.value,
          )
          return sendJson(res, 200, { accepted: true })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionAuthFlow = p.match(/^\/api\/v1\/sessions\/([^/]+)\/auth-flows\/([^/]+)$/)
      if (method === "DELETE" && sessionAuthFlow) {
        try {
          await sessions.cancelSessionProviderAuth(
            decodeURIComponent(sessionAuthFlow[1]), decodeURIComponent(sessionAuthFlow[2]),
          )
          res.writeHead(204)
          return res.end()
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionProviderAuth = p.match(/^\/api\/v1\/sessions\/([^/]+)\/providers\/([^/]+)\/auth$/)
      if (method === "DELETE" && sessionProviderAuth) {
        try {
          await sessions.logoutSessionProvider(
            decodeURIComponent(sessionProviderAuth[1]), decodeURIComponent(sessionProviderAuth[2]),
          )
          res.writeHead(204)
          return res.end()
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionModelRuntime = p.match(/^\/api\/v1\/sessions\/([^/]+)\/model-runtime(?:\/(reload|refresh))?$/)
      if (sessionModelRuntime && (method === "GET" || method === "POST")) {
        const sessionId = decodeURIComponent(sessionModelRuntime[1])
        const action = sessionModelRuntime[2]
        if (method === "GET" && action) return sendMethodNotAllowed(res, "POST")
        if (method === "POST" && !action) return sendMethodNotAllowed(res, "GET")
        try {
          if (method === "GET") return sendJson(res, 200, await sessions.inspectSessionModelRuntime(sessionId))
          if (action === "reload") {
            await sessions.reloadSessionModelRuntime(sessionId)
            return sendJson(res, 200, { reloaded: true })
          }
          const raw = await readBody(req)
          let options: Record<string, unknown>
          try {
            options = JSON.parse(raw || "{}") as Record<string, unknown>
          } catch {
            return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
          }
          return sendJson(res, 200, { result: await sessions.refreshSessionModelRuntime(sessionId, options) })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionRuntimeApiKey = p.match(
        /^\/api\/v1\/sessions\/([^/]+)\/providers\/([^/]+)\/runtime-api-key$/,
      )
      if (sessionRuntimeApiKey && (method === "PUT" || method === "DELETE")) {
        const sessionId = decodeURIComponent(sessionRuntimeApiKey[1])
        const providerId = decodeURIComponent(sessionRuntimeApiKey[2])
        try {
          if (method === "DELETE") {
            await sessions.removeSessionRuntimeApiKey(sessionId, providerId)
            res.writeHead(204)
            return res.end()
          }
          const raw = await readBody(req)
          let body: { apiKey?: string }
          try {
            body = JSON.parse(raw || "{}") as typeof body
          } catch {
            return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
          }
          if (!body.apiKey) return sendProblem(res, 400, "INVALID_REQUEST", "apiKey required")
          await sessions.setSessionRuntimeApiKey(sessionId, providerId, body.apiKey)
          return sendJson(res, 200, { configured: true })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const workspaceSettings = p.match(/^\/api\/v1\/workspaces\/([^/]+)\/pi-settings$/)
      if (workspaceSettings && (method === "GET" || method === "PATCH")) {
        const workspacePath = decodeURIComponent(workspaceSettings[1])
        try {
          if (method === "GET") return sendJson(res, 200, await sessions.getSettings(workspacePath))
          const raw = await readBody(req)
          let patch: Record<string, unknown>
          try {
            patch = JSON.parse(raw || "{}") as Record<string, unknown>
          } catch {
            return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
          }
          if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
            return sendProblem(res, 400, "INVALID_REQUEST", "settings patch must be an object")
          }
          const result = await sessions.patchSettings(workspacePath, patch)
          return sendJson(res, 200, result)
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const workspaceTrust = p.match(/^\/api\/v1\/workspaces\/([^/]+)\/trust$/)
      if (workspaceTrust && (method === "GET" || method === "PUT")) {
        const workspacePath = decodeURIComponent(workspaceTrust[1])
        try {
          if (method === "GET") return sendJson(res, 200, await sessions.getProjectTrust(workspacePath))
          const raw = await readBody(req)
          let body: { decision?: boolean | null }
          try {
            body = JSON.parse(raw || "{}") as typeof body
          } catch {
            return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
          }
          if (!("decision" in body) || (body.decision !== true && body.decision !== false && body.decision !== null)) {
            return sendProblem(res, 400, "INVALID_REQUEST", "decision must be true, false, or null")
          }
          return sendJson(res, 200, await sessions.setProjectTrust(workspacePath, body.decision))
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const workspacePackages = p.match(/^\/api\/v1\/workspaces\/([^/]+)\/packages$/)
      if (method === "GET" && workspacePackages) {
        try {
          return sendJson(res, 200, { packages: await sessions.listPackages(decodeURIComponent(workspacePackages[1])) })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const workspacePackageResolved = p.match(/^\/api\/v1\/workspaces\/([^/]+)\/packages\/resolved$/)
      if (method === "GET" && workspacePackageResolved) {
        const missingAction = url.searchParams.get("missingAction")
        if (missingAction && missingAction !== "install" && missingAction !== "skip" && missingAction !== "error") {
          return sendProblem(res, 400, "INVALID_REQUEST", "missingAction must be install, skip, or error")
        }
        try {
          return sendJson(res, 200, await sessions.resolvePackages(
            decodeURIComponent(workspacePackageResolved[1]),
            (missingAction || undefined) as "install" | "skip" | "error" | undefined,
          ))
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const workspacePackageResolveSources = p.match(
        /^\/api\/v1\/workspaces\/([^/]+)\/packages\/resolve-extension-sources$/,
      )
      if (method === "POST" && workspacePackageResolveSources) {
        const raw = await readBody(req)
        let body: { sources?: string[]; local?: boolean; temporary?: boolean }
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (!Array.isArray(body.sources) || body.sources.some(source => typeof source !== "string")) {
          return sendProblem(res, 400, "INVALID_REQUEST", "sources must be an array of strings")
        }
        try {
          return sendJson(res, 200, await sessions.resolveExtensionSources(
            decodeURIComponent(workspacePackageResolveSources[1]),
            body.sources,
            { local: body.local, temporary: body.temporary },
          ))
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const workspacePackageSources = p.match(/^\/api\/v1\/workspaces\/([^/]+)\/packages\/sources$/)
      if ((method === "POST" || method === "DELETE") && workspacePackageSources) {
        const raw = await readBody(req)
        let body: { source?: string; local?: boolean }
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (!body.source?.trim()) return sendProblem(res, 400, "INVALID_REQUEST", "package source required")
        try {
          return sendJson(res, 200, await sessions.changePackageSource(
            decodeURIComponent(workspacePackageSources[1]),
            body.source.trim(),
            method === "POST" ? "add" : "remove",
            body.local,
          ))
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const workspacePackagePath = p.match(/^\/api\/v1\/workspaces\/([^/]+)\/packages\/installed-path$/)
      if (method === "GET" && workspacePackagePath) {
        const source = url.searchParams.get("source")?.trim()
        const scope = url.searchParams.get("scope")
        if (!source || (scope !== "user" && scope !== "project")) {
          return sendProblem(res, 400, "INVALID_REQUEST", "source and user/project scope required")
        }
        try {
          return sendJson(res, 200, {
            path: await sessions.getInstalledPackagePath(
              decodeURIComponent(workspacePackagePath[1]), source, scope,
            ),
          })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const workspacePackageUpdates = p.match(/^\/api\/v1\/workspaces\/([^/]+)\/packages\/updates$/)
      if (method === "GET" && workspacePackageUpdates) {
        try {
          return sendJson(res, 200, {
            updates: await sessions.checkPackageUpdates(decodeURIComponent(workspacePackageUpdates[1])),
          })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const workspacePackageCommand = p.match(
        /^\/api\/v1\/workspaces\/([^/]+)\/commands\/packages\/(install|remove|update)$/,
      )
      if (method === "POST" && workspacePackageCommand) {
        const workspacePath = decodeURIComponent(workspacePackageCommand[1])
        const action = workspacePackageCommand[2] as "install" | "remove" | "update"
        const body = await readCommandBody<{ source?: string; local?: boolean; persist?: boolean }>(req)
        if ((action === "install" || action === "remove") && !body.source?.trim()) {
          return sendProblem(res, 400, "INVALID_REQUEST", "package source required")
        }
        const commandId = resolveCommandId(req, body)
        try {
          const packages = await sessions.managePackage(
            workspacePath,
            commandId,
            action,
            body.source?.trim(),
            body.local === true,
            body.persist !== false,
          )
          return sendJson(res, 200, { commandId, packages })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      if (method === "GET" && p === "/api/v1/sessions") {
        const workspacePath = url.searchParams.get("workspacePath") ?? undefined
        try {
          const list = (await sessions.list(workspacePath))
            .slice()
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map(session => sessionSummary(session, sessions.snapshot(session).session.state))
          return sendJson(res, 200, { sessions: list })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      if (method === "POST" && p === "/api/v1/sessions") {
        const raw = await readBody(req)
        let body: { workspacePath?: string; title?: string; seedMock?: boolean }
        try {
          body = JSON.parse(raw || "{}") as { workspacePath?: string; title?: string; seedMock?: boolean }
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        try {
          const workspacePath = body.workspacePath || (await ensureDefaultWorkspace())
          const s = await sessions.create(workspacePath, {
            title: body.title,
            seedMock: body.seedMock === true,
          })
          publishSessionUpdated(s)
          return sendJson(res, 201, {
            session: sessionSummary(s, sessions.snapshot(s).session.state),
            snapshot: sessions.snapshot(s),
            driver: sessions.getDriver(),
          })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionSnap = p.match(/^\/api\/v1\/sessions\/([^/]+)\/snapshot$/)
      if (method === "GET" && sessionSnap) {
        const id = decodeURIComponent(sessionSnap[1])
        try {
          const s = await sessions.find(id)
          if (!s) return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
          const attached = await sessions.attach(id)
          return sendJson(res, 200, sessions.snapshot(attached))
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionModels = p.match(/^\/api\/v1\/sessions\/([^/]+)\/models$/)
      if (method === "GET" && sessionModels) {
        try {
          const models = await sessions.listSessionModels(decodeURIComponent(sessionModels[1]))
          return sendJson(res, 200, models.map(model => ({
            id: model.id,
            name: model.name,
            providerId: model.providerId,
            family: model.family,
            contextLimit: model.contextLimit,
            outputLimit: model.outputLimit,
            supportsReasoning: model.supportsReasoning,
            supportsImages: model.supportsImages,
            variants: model.thinkingLevels,
          })))
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const extensionUiSnapshot = p.match(/^\/api\/v1\/sessions\/([^/]+)\/extension-ui$/)
      if (method === "GET" && extensionUiSnapshot) {
        const id = decodeURIComponent(extensionUiSnapshot[1])
        const snapshot = sessions.extensionUiSnapshot(id)
        if (!snapshot) return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
        return sendJson(res, 200, snapshot)
      }

      const sessionSystemPrompt = p.match(/^\/api\/v1\/sessions\/([^/]+)\/system-prompt$/)
      if (method === "GET" && sessionSystemPrompt) {
        try {
          return sendJson(res, 200, { text: await sessions.getSystemPrompt(decodeURIComponent(sessionSystemPrompt[1])) })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionInspection = p.match(/^\/api\/v1\/sessions\/([^/]+)\/(runtime-inspection|resources)$/)
      if (method === "GET" && sessionInspection) {
        const id = decodeURIComponent(sessionInspection[1])
        try {
          return sendJson(
            res,
            200,
            sessionInspection[2] === "resources"
              ? await sessions.inspectResources(id)
              : await sessions.inspectRuntime(id),
          )
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }
      const sessionToolDefinition = p.match(/^\/api\/v1\/sessions\/([^/]+)\/tools\/([^/]+)\/definition$/)
      if (method === "GET" && sessionToolDefinition) {
        try {
          return sendJson(res, 200, {
            definition: await sessions.getToolDefinition(
              decodeURIComponent(sessionToolDefinition[1]),
              decodeURIComponent(sessionToolDefinition[2]),
            ),
          })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }
      const sessionExtensionHandlers = p.match(/^\/api\/v1\/sessions\/([^/]+)\/extension-handlers\/([^/]+)$/)
      if (method === "GET" && sessionExtensionHandlers) {
        try {
          return sendJson(res, 200, {
            registered: await sessions.hasExtensionHandlers(
              decodeURIComponent(sessionExtensionHandlers[1]),
              decodeURIComponent(sessionExtensionHandlers[2]),
            ),
          })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }
      if (method === "POST" && sessionInspection?.[2] === "resources") {
        const id = decodeURIComponent(sessionInspection[1])
        const raw = await readBody(req)
        let body: import("@piui/protocol").PiResourceExtensionPathsV1
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return sendProblem(res, 400, "INVALID_REQUEST", "resource paths must be an object")
        }
        try {
          return sendJson(res, 200, await sessions.extendResources(id, body))
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }
      if (method === "PUT" && extensionUiSnapshot) {
        const id = decodeURIComponent(extensionUiSnapshot[1])
        const raw = await readBody(req)
        let body: { editorText?: string }
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (typeof body.editorText !== "string") {
          return sendProblem(res, 400, "INVALID_REQUEST", "editorText required")
        }
        try {
          await sessions.setExtensionEditorState(id, body.editorText)
          return sendJson(res, 200, sessions.extensionUiSnapshot(id))
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const extensionUiResponse = p.match(/^\/api\/v1\/sessions\/([^/]+)\/extension-ui\/requests\/([^/]+)\/response$/)
      if (method === "POST" && extensionUiResponse) {
        const sessionId = decodeURIComponent(extensionUiResponse[1])
        const requestId = decodeURIComponent(extensionUiResponse[2])
        const raw = await readBody(req)
        let body: (ExtensionUiDialogResponseV1 & { workerGeneration?: string })
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        const responseFields = ["cancelled", "confirmed", "value"].filter(key => key in body)
        if (responseFields.length !== 1) {
          return sendProblem(res, 400, "INVALID_REQUEST", "response requires exactly one of cancelled, confirmed, or value")
        }
        if (body.responseId !== undefined && (typeof body.responseId !== "string" || !body.responseId)) {
          return sendProblem(res, 400, "INVALID_REQUEST", "responseId must be a non-empty string")
        }
        let response: ExtensionUiDialogResponseV1
        if ("cancelled" in body) {
          if (body.cancelled !== true) {
            return sendProblem(res, 400, "INVALID_REQUEST", "cancelled must be true when present")
          }
          response = { cancelled: true, responseId: body.responseId }
        } else if ("confirmed" in body) {
          if (typeof body.confirmed !== "boolean") {
            return sendProblem(res, 400, "INVALID_REQUEST", "confirmed must be a boolean")
          }
          response = { confirmed: body.confirmed, responseId: body.responseId }
        } else if ("value" in body) {
          if (typeof body.value !== "string") {
            return sendProblem(res, 400, "INVALID_REQUEST", "value must be a string")
          }
          response = { value: body.value, responseId: body.responseId }
        } else {
          return sendProblem(res, 400, "INVALID_REQUEST", "response requires cancelled, confirmed, or value")
        }
        try {
          const result = await sessions.respondExtensionUi(sessionId, requestId, response, body.workerGeneration)
          return sendJson(res, 200, { requestId, accepted: true, ...result })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionOnly = p.match(/^\/api\/v1\/sessions\/([^/]+)$/)
      if (method === "DELETE" && sessionOnly) {
        const id = decodeURIComponent(sessionOnly[1])
        const body = await readCommandBody(req)
        const session = await sessions.find(id)
        if (!session) return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.delete",
              concurrency: "idle-only",
              sessionId: id,
              payload: { durable: true },
            },
            () => sessions.delete(id),
          )
          await submitted.promise
          publishSessionUpdated(session)
          return sendJson(res, 200, { ok: true, id, commandId, command: submitted.record })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionPrompt = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/(prompt|steer|follow-up)$/)
      if (method === "POST" && sessionPrompt) {
        const id = decodeURIComponent(sessionPrompt[1])
        const operation = sessionPrompt[2] as "prompt" | "steer" | "follow-up"
        const body = await readCommandBody<{
          text?: string
          stream?: boolean
          model?: { provider?: string; id?: string }
          thinkingLevel?: string
          attachments?: SessionAttachmentV2[]
          expandPromptTemplates?: boolean
        }>(req, MAX_PROMPT_BODY_BYTES)
        try {
          const knownSession = await sessions.find(id)
          if (!knownSession) return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
          // stream defaults off for tests/speed; client passes stream:true for UI
          const stream = body.stream === true
          const commandId = resolveCommandId(req, body)
          const submitted = operation === "prompt"
            ? sessionExecutor.submit(
                {
                  protocolVersion: 2,
                  commandId,
                  type: "session.prompt",
                  concurrency: /^\/[^\s/]+(?:\s|$)/.test(body.text ?? "") ? "run-control" : "idle-only",
                  sessionId: id,
                  payload: {
                    text: body.text ?? "",
                    model: body.model?.provider && body.model.id
                      ? { provider: body.model.provider, modelId: body.model.id }
                      : undefined,
                    thinkingLevel: body.thinkingLevel,
                    attachments: body.attachments,
                    expandPromptTemplates: body.expandPromptTemplates,
                  },
                },
                () => sessions.prompt(id, body.text ?? "", {
                  stream,
                  model: body.model,
                  thinkingLevel: body.thinkingLevel,
                  attachments: body.attachments,
                  expandPromptTemplates: body.expandPromptTemplates,
                  onTick: publishSessionSnapshot,
                  onMetadataChange: session => {
                    publishSessionSnapshot(session)
                    publishSessionUpdated(session)
                  },
                }),
                {
                  recordRequest: request => ({
                    ...request,
                    payload: { ...request.payload, attachments: redactAttachmentData(request.payload.attachments) },
                  }),
                },
              )
            : operation === "steer"
              ? sessionExecutor.submit(
                  {
                    protocolVersion: 2,
                    commandId,
                    type: "session.steer",
                    concurrency: "run-control",
                    sessionId: id,
                    payload: { text: body.text ?? "", attachments: body.attachments },
                  },
                  () => sessions.deliverControl(id, body.text ?? "", "steer", body.attachments),
                  {
                    recordRequest: request => ({
                      ...request,
                      payload: { ...request.payload, attachments: redactAttachmentData(request.payload.attachments) },
                    }),
                  },
                )
              : sessionExecutor.submit(
                  {
                    protocolVersion: 2,
                    commandId,
                    type: "session.followUp",
                    concurrency: "run-control",
                    sessionId: id,
                    payload: { text: body.text ?? "", attachments: body.attachments },
                  },
                  () => sessions.deliverControl(id, body.text ?? "", "followUp", body.attachments),
                  {
                    recordRequest: request => ({
                      ...request,
                      payload: { ...request.payload, attachments: redactAttachmentData(request.payload.attachments) },
                    }),
                  },
                )
          void submitted.promise.then(session => {
            publishSessionSnapshot(session)
            publishSessionUpdated(session)
          }).catch(() => undefined)
          return sendJson(res, 202, {
            commandId,
            accepted: true,
            reused: submitted.reused,
            command: submitted.record,
            snapshot: sessions.snapshot(knownSession),
          })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionAbort = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/abort$/)
      if (method === "POST" && sessionAbort) {
        const id = decodeURIComponent(sessionAbort[1])
        const body = await readCommandBody(req)
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.abort",
              concurrency: "run-control",
              sessionId: id,
              payload: {},
            },
            () => sessions.abort(id),
          )
          const result = await submitted.promise
          if (!result) return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
          publishSessionSnapshot(result.session)
          publishSessionUpdated(result.session)
          return sendJson(res, 200, {
            commandId,
            accepted: true,
            reused: submitted.reused,
            command: submitted.record,
            cleared: result.cleared,
            snapshot: sessions.snapshot(result.session),
          })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionBash = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/bash$/)
      if (method === "POST" && sessionBash) {
        const id = decodeURIComponent(sessionBash[1])
        const body = await readCommandBody<{ command?: string; excludeFromContext?: boolean }>(req)
        if (!body.command?.trim()) return sendProblem(res, 400, "INVALID_REQUEST", "command required")
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.executeBash",
              concurrency: "idle-only",
              sessionId: id,
              payload: { command: body.command, excludeFromContext: body.excludeFromContext === true },
            },
            () => sessions.executeBash(id, body.command!, body.excludeFromContext === true),
            // The record is the only delivery channel for excludeFromContext
            // runs, so the output has to stay; retention is bounded instead.
            { recordResult: result => result },
          )
          void submitted.promise.then(async () => {
            const session = await sessions.find(id)
            if (session) publishSessionSnapshot(session)
          }).catch(() => undefined)
          return sendJson(res, 202, { commandId, accepted: true, reused: submitted.reused, command: submitted.record })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionAbortBash = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/abort-bash$/)
      if (method === "POST" && sessionAbortBash) {
        const id = decodeURIComponent(sessionAbortBash[1])
        const body = await readCommandBody(req)
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.abortBash",
              concurrency: "run-control",
              sessionId: id,
              payload: {},
            },
            () => sessions.abortBash(id),
          )
          const session = await submitted.promise
          publishSessionSnapshot(session)
          return sendJson(res, 200, { commandId, command: submitted.record, snapshot: sessions.snapshot(session) })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionExport = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/export-(html|jsonl)$/)
      if (method === "POST" && sessionExport) {
        const id = decodeURIComponent(sessionExport[1])
        const format = sessionExport[2] as "html" | "jsonl"
        const body = await readCommandBody<{ outputPath?: string }>(req)
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: format === "html" ? "session.exportHtml" : "session.exportJsonl",
              concurrency: "idle-only",
              sessionId: id,
              payload: { outputPath: body.outputPath },
            },
            () => sessions.exportSession(id, format, body.outputPath),
            { recordResult: result => result },
          )
          void submitted.promise.catch(() => undefined)
          return sendJson(res, 202, { commandId, accepted: true, reused: submitted.reused, command: submitted.record })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionReload = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/reload-resources$/)
      if (method === "POST" && sessionReload) {
        const id = decodeURIComponent(sessionReload[1])
        const body = await readCommandBody(req)
        try {
          const session = await sessions.find(id)
          if (!session) return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "resources.reload",
              concurrency: "idle-only",
              sessionId: id,
              workspacePath: session.cwd,
              payload: { workspacePath: session.cwd },
            },
            () => sessions.reloadResources(id, commandId),
          )
          void submitted.promise.then(updated => {
            publishSessionSnapshot(updated)
          }).catch(() => undefined)
          return sendJson(res, 202, { commandId, accepted: true, reused: submitted.reused, command: submitted.record })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionCustomMessage = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/custom-message$/)
      if (method === "POST" && sessionCustomMessage) {
        const id = decodeURIComponent(sessionCustomMessage[1])
        const raw = await readBody(req, MAX_PROMPT_BODY_BYTES)
        let body: {
          customType?: string
          content?: CustomMessageContentV1[]
          display?: boolean
          details?: unknown
          triggerTurn?: boolean
          deliverAs?: "steer" | "followUp" | "nextTurn"
        }
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (!body.customType?.trim() || !Array.isArray(body.content)) {
          return sendProblem(res, 400, "INVALID_REQUEST", "customType and content required")
        }
        if (body.content.some(block => !block || (block.type !== "text" && block.type !== "image"))) {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid custom message content")
        }
        if (body.deliverAs && !["steer", "followUp", "nextTurn"].includes(body.deliverAs)) {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid custom message delivery")
        }
        try {
          const session = await sessions.sendCustomMessage(id, body.customType, body.content, {
            display: body.display !== false,
            details: body.details,
            triggerTurn: body.triggerTurn,
            deliverAs: body.deliverAs,
          })
          publishSessionSnapshot(session)
          return sendJson(res, 200, sessions.snapshot(session))
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionCustomEntry = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/custom-entry$/)
      if (method === "POST" && sessionCustomEntry) {
        const id = decodeURIComponent(sessionCustomEntry[1])
        const raw = await readBody(req, MAX_PROMPT_BODY_BYTES)
        let body: { customType?: string; data?: unknown }
        try {
          body = JSON.parse(raw || "{}") as typeof body
        } catch {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid json")
        }
        if (!body.customType?.trim()) return sendProblem(res, 400, "INVALID_REQUEST", "customType required")
        try {
          const session = await sessions.appendCustomEntry(id, body.customType, body.data)
          publishSessionSnapshot(session)
          return sendJson(res, 200, sessions.snapshot(session))
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionWaitIdle = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/wait-for-idle$/)
      if (method === "POST" && sessionWaitIdle) {
        try {
          const session = await sessions.waitForIdle(decodeURIComponent(sessionWaitIdle[1]))
          return sendJson(res, 200, sessions.snapshot(session))
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionSetModel = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/set-model$/)
      if (method === "POST" && sessionSetModel) {
        const id = decodeURIComponent(sessionSetModel[1])
        const body = await readCommandBody<{ provider?: string; id?: string }>(req)
        if (!body.provider || !body.id) {
          return sendProblem(res, 400, "INVALID_REQUEST", "provider and id required")
        }
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.setModel",
              concurrency: "idle-only",
              sessionId: id,
              payload: { provider: body.provider, modelId: body.id },
            },
            () => sessions.setModel(id, body.provider!, body.id!),
          )
          const s = await submitted.promise
          publishSessionSnapshot(s)
          publishSessionUpdated(s)
          return sendJson(res, 200, { commandId, command: submitted.record, snapshot: sessions.snapshot(s) })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionCycleModel = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/cycle-model$/)
      if (method === "POST" && sessionCycleModel) {
        const id = decodeURIComponent(sessionCycleModel[1])
        const body = await readCommandBody<{ direction?: "forward" | "backward" }>(req)
        if (body.direction && body.direction !== "forward" && body.direction !== "backward") {
          return sendProblem(res, 400, "INVALID_REQUEST", "invalid direction")
        }
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.cycleModel",
              concurrency: "idle-only",
              sessionId: id,
              payload: { direction: body.direction },
            },
            () => sessions.cycleModel(id, body.direction),
          )
          const session = await submitted.promise
          publishSessionSnapshot(session)
          return sendJson(res, 200, { commandId, command: submitted.record, snapshot: sessions.snapshot(session) })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionScopedModels = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/set-scoped-models$/)
      if (method === "POST" && sessionScopedModels) {
        const id = decodeURIComponent(sessionScopedModels[1])
        const body = await readCommandBody<{ patterns?: string[] }>(req)
        if (!Array.isArray(body.patterns) || body.patterns.some(pattern => typeof pattern !== "string")) {
          return sendProblem(res, 400, "INVALID_REQUEST", "patterns must be a string array")
        }
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.setScopedModels",
              concurrency: "idle-only",
              sessionId: id,
              payload: { patterns: body.patterns },
            },
            () => sessions.setScopedModels(id, body.patterns!),
            { recordResult: result => ({ diagnostics: result.diagnostics }) },
          )
          const result = await submitted.promise
          publishSessionSnapshot(result.session)
          return sendJson(res, 200, {
            commandId,
            command: submitted.record,
            diagnostics: result.diagnostics,
            snapshot: sessions.snapshot(result.session),
          })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionThinking = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/set-thinking-level$/)
      if (method === "POST" && sessionThinking) {
        const id = decodeURIComponent(sessionThinking[1])
        const body = await readCommandBody<{ level?: string }>(req)
        if (!body.level) return sendProblem(res, 400, "INVALID_REQUEST", "level required")
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.setThinkingLevel",
              concurrency: "idle-only",
              sessionId: id,
              payload: { level: body.level },
            },
            () => sessions.setThinkingLevel(id, body.level!),
          )
          const s = await submitted.promise
          publishSessionSnapshot(s)
          publishSessionUpdated(s)
          return sendJson(res, 200, { commandId, command: submitted.record, snapshot: sessions.snapshot(s) })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionCycleThinking = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/cycle-thinking-level$/)
      if (method === "POST" && sessionCycleThinking) {
        const id = decodeURIComponent(sessionCycleThinking[1])
        const body = await readCommandBody(req)
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.cycleThinkingLevel",
              concurrency: "idle-only",
              sessionId: id,
              payload: {},
            },
            () => sessions.cycleThinkingLevel(id),
          )
          const { session: s, level } = await submitted.promise
          publishSessionSnapshot(s)
          publishSessionUpdated(s)
          return sendJson(res, 200, { commandId, command: submitted.record, level, snapshot: sessions.snapshot(s) })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionUserMessage = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/send-user-message$/)
      if (method === "POST" && sessionUserMessage) {
        const id = decodeURIComponent(sessionUserMessage[1])
        const body = await readCommandBody<{
          text?: string
          deliverAs?: "steer" | "followUp"
          attachments?: SessionAttachmentV2[]
        }>(req, MAX_PROMPT_BODY_BYTES)
        if (typeof body.text !== "string") {
          return sendProblem(res, 400, "INVALID_REQUEST", "text required")
        }
        if (body.deliverAs !== undefined && body.deliverAs !== "steer" && body.deliverAs !== "followUp") {
          return sendProblem(res, 400, "INVALID_REQUEST", "deliverAs must be steer or followUp")
        }
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              // Queued delivery joins a running turn; otherwise it starts one.
              concurrency: body.deliverAs ? "run-control" : "idle-only",
              type: "session.sendUserMessage",
              sessionId: id,
              payload: { text: body.text, deliverAs: body.deliverAs, attachments: body.attachments },
            },
            () => sessions.sendUserMessage(id, body.text!, {
              deliverAs: body.deliverAs,
              attachments: body.attachments,
            }),
            {
              recordRequest: request => ({
                ...request,
                payload: { ...request.payload, attachments: redactAttachmentData(request.payload.attachments) },
              }),
            },
          )
          void submitted.promise.then(session => {
            publishSessionSnapshot(session)
            publishSessionUpdated(session)
          }).catch(() => undefined)
          return sendJson(res, 202, {
            commandId,
            accepted: true,
            reused: submitted.reused,
            command: submitted.record,
          })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionCompact = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/compact$/)
      if (method === "POST" && sessionCompact) {
        const id = decodeURIComponent(sessionCompact[1])
        const body = await readCommandBody<{ instructions?: string }>(req)
        try {
          const knownSession = await sessions.find(id)
          if (!knownSession) return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.compact",
              concurrency: "idle-only",
              sessionId: id,
              payload: { instructions: body.instructions },
            },
            () => sessions.compact(id, body.instructions),
          )
          void submitted.promise.then(({ session }) => {
            publishSessionSnapshot(session)
            publishSessionUpdated(session)
          }).catch(() => undefined)
          return sendJson(res, 202, {
            commandId,
            accepted: true,
            reused: submitted.reused,
            command: submitted.record,
            snapshot: sessions.snapshot(knownSession),
          })
        } catch (e) {
          return handleSessionCmdError(res, e)
        }
      }

      const sessionRuntimeControl = p.match(
        /^\/api\/v1\/sessions\/([^/]+)\/commands\/(abort-compaction|abort-branch-summary|abort-retry|clear-queue)$/,
      )
      if (method === "POST" && sessionRuntimeControl) {
        const id = decodeURIComponent(sessionRuntimeControl[1])
        const operation = sessionRuntimeControl[2]
        const body = await readCommandBody(req)
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = operation === "abort-compaction"
            ? sessionExecutor.submit(
                {
                  protocolVersion: 2,
                  commandId,
                  type: "session.abortCompaction",
                  concurrency: "run-control",
                  sessionId: id,
                  payload: {},
                },
                () => sessions.abortCompaction(id),
              )
            : operation === "abort-branch-summary"
              ? sessionExecutor.submit(
                  {
                    protocolVersion: 2,
                    commandId,
                    type: "session.abortBranchSummary",
                    concurrency: "run-control",
                    sessionId: id,
                    payload: {},
                  },
                  () => sessions.abortBranchSummary(id),
                )
              : operation === "abort-retry"
                ? sessionExecutor.submit(
                    {
                      protocolVersion: 2,
                      commandId,
                      type: "session.abortRetry",
                      concurrency: "run-control",
                      sessionId: id,
                      payload: {},
                    },
                    () => sessions.abortRetry(id),
                  )
                : sessionExecutor.submit(
                    {
                      protocolVersion: 2,
                      commandId,
                      type: "session.clearQueue",
                      concurrency: "run-control",
                      sessionId: id,
                      payload: {},
                    },
                    () => sessions.clearQueue(id),
                  )
          const result = await submitted.promise
          const session = "session" in result ? result.session : result
          publishSessionSnapshot(session)
          return sendJson(res, 200, {
            commandId,
            command: submitted.record,
            cleared: "cleared" in result ? result.cleared : undefined,
            snapshot: sessions.snapshot(session),
          })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionRuntimeSetting = p.match(
        /^\/api\/v1\/sessions\/([^/]+)\/commands\/(set-auto-compaction|set-auto-retry|set-queue-modes|set-tools)$/,
      )
      if (method === "POST" && sessionRuntimeSetting) {
        const id = decodeURIComponent(sessionRuntimeSetting[1])
        const operation = sessionRuntimeSetting[2]
        const body = await readCommandBody<{
          enabled?: boolean
          steeringMode?: "all" | "one-at-a-time"
          followUpMode?: "all" | "one-at-a-time"
          toolNames?: string[]
        }>(req)
        try {
          const commandId = resolveCommandId(req, body)
          if ((operation === "set-auto-compaction" || operation === "set-auto-retry") && typeof body.enabled !== "boolean") {
            return sendProblem(res, 400, "INVALID_REQUEST", "enabled must be boolean")
          }
          if (operation === "set-queue-modes" &&
            body.steeringMode === undefined && body.followUpMode === undefined) {
            return sendProblem(res, 400, "INVALID_REQUEST", "at least one queue mode is required")
          }
          if (
            (body.steeringMode !== undefined && body.steeringMode !== "all" && body.steeringMode !== "one-at-a-time") ||
            (body.followUpMode !== undefined && body.followUpMode !== "all" && body.followUpMode !== "one-at-a-time")
          ) {
            return sendProblem(res, 400, "INVALID_REQUEST", "invalid queue mode")
          }
          if (operation === "set-tools" && !Array.isArray(body.toolNames)) {
            return sendProblem(res, 400, "INVALID_REQUEST", "toolNames must be an array")
          }
          if (operation === "set-tools" && body.toolNames!.some(name => typeof name !== "string" || !name)) {
            return sendProblem(res, 400, "INVALID_REQUEST", "toolNames must contain non-empty strings")
          }
          const submitted = operation === "set-auto-compaction"
            ? sessionExecutor.submit(
                {
                  protocolVersion: 2,
                  commandId,
                  type: "session.setAutoCompaction",
                  concurrency: "idle-only",
                  sessionId: id,
                  payload: { enabled: body.enabled! },
                },
                () => sessions.setAutoCompaction(id, body.enabled!),
              )
            : operation === "set-auto-retry"
              ? sessionExecutor.submit(
                  {
                    protocolVersion: 2,
                    commandId,
                    type: "session.setAutoRetry",
                    concurrency: "idle-only",
                    sessionId: id,
                    payload: { enabled: body.enabled! },
                  },
                  () => sessions.setAutoRetry(id, body.enabled!),
                )
              : operation === "set-queue-modes"
                ? sessionExecutor.submit(
                    {
                      protocolVersion: 2,
                      commandId,
                      type: "session.setQueueModes",
                      concurrency: "idle-only",
                      sessionId: id,
                      payload: {
                        steeringMode: body.steeringMode,
                        followUpMode: body.followUpMode,
                      },
                    },
                    () => sessions.setQueueModes(id, {
                      steeringMode: body.steeringMode,
                      followUpMode: body.followUpMode,
                    }),
                  )
                : sessionExecutor.submit(
                    {
                      protocolVersion: 2,
                      commandId,
                      type: "session.setActiveTools",
                      concurrency: "idle-only",
                      sessionId: id,
                      payload: { toolNames: body.toolNames! },
                    },
                    () => sessions.setActiveTools(id, body.toolNames!),
                  )
          const session = await submitted.promise
          publishSessionSnapshot(session)
          return sendJson(res, 200, {
            commandId,
            command: submitted.record,
            snapshot: sessions.snapshot(session),
          })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionNavigate = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/navigate-tree$/)
      if (method === "POST" && sessionNavigate) {
        const id = decodeURIComponent(sessionNavigate[1])
        const body = await readCommandBody<{
          entryId?: string
          summarize?: boolean
          customInstructions?: string
          replaceInstructions?: boolean
          label?: string
        }>(req)
        if (!body.entryId) return sendProblem(res, 400, "INVALID_REQUEST", "entryId required")
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.navigateTree",
              concurrency: "idle-only",
              sessionId: id,
              payload: {
                entryId: body.entryId,
                summarizeAbandonedBranch: body.summarize === true,
                customInstructions: body.customInstructions,
                replaceInstructions: body.replaceInstructions,
                label: body.label,
              },
            },
            () => sessions.navigateTree(id, body.entryId!, {
              summarize: body.summarize,
              customInstructions: body.customInstructions,
              replaceInstructions: body.replaceInstructions,
              label: body.label,
            }),
          )
          const result = await submitted.promise
          publishSessionSnapshot(result.session)
          return sendJson(res, 200, {
            commandId,
            command: submitted.record,
            editorText: result.editorText,
            cancelled: result.cancelled,
            aborted: result.aborted,
            summaryEntry: result.summaryEntry,
            snapshot: sessions.snapshot(result.session),
          })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionLabel = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/set-label$/)
      if (method === "POST" && sessionLabel) {
        const id = decodeURIComponent(sessionLabel[1])
        const body = await readCommandBody<{ entryId?: string; label?: string }>(req)
        if (!body.entryId) return sendProblem(res, 400, "INVALID_REQUEST", "entryId required")
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.setLabel",
              concurrency: "idle-only",
              sessionId: id,
              payload: { entryId: body.entryId, label: body.label },
            },
            () => sessions.setLabel(id, body.entryId!, body.label),
          )
          const session = await submitted.promise
          publishSessionSnapshot(session)
          return sendJson(res, 200, { commandId, command: submitted.record, snapshot: sessions.snapshot(session) })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionName = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/set-name$/)
      if (method === "POST" && sessionName) {
        const id = decodeURIComponent(sessionName[1])
        const body = await readCommandBody<{ name?: string }>(req)
        if (typeof body.name !== "string") return sendProblem(res, 400, "INVALID_REQUEST", "name required")
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = sessionExecutor.submit(
            {
              protocolVersion: 2,
              commandId,
              type: "session.setName",
              concurrency: "idle-only",
              sessionId: id,
              payload: { name: body.name },
            },
            () => sessions.setSessionName(id, body.name!),
          )
          const session = await submitted.promise
          publishSessionSnapshot(session)
          publishSessionUpdated(session)
          return sendJson(res, 200, { commandId, command: submitted.record, snapshot: sessions.snapshot(session) })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const runtimeReplacement = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/(new-session|switch-session)$/)
      if (method === "POST" && runtimeReplacement) {
        const id = decodeURIComponent(runtimeReplacement[1])
        const operation = runtimeReplacement[2]
        const body = await readCommandBody<{ parentSessionId?: string; targetSessionId?: string }>(req)
        if (operation === "switch-session" && !body.targetSessionId) {
          return sendProblem(res, 400, "INVALID_REQUEST", "targetSessionId required")
        }
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = operation === "new-session"
            ? sessionExecutor.submit(
                {
                  protocolVersion: 2,
                  commandId,
                  type: "session.new",
                  concurrency: "idle-only",
                  sessionId: id,
                  payload: { parentSessionId: body.parentSessionId },
                },
                () => sessions.newSession(id, body.parentSessionId),
              )
            : sessionExecutor.submit(
                {
                  protocolVersion: 2,
                  commandId,
                  type: "session.switch",
                  concurrency: "idle-only",
                  sessionId: id,
                  payload: { targetSessionId: body.targetSessionId! },
                },
                () => sessions.switchSession(id, body.targetSessionId!),
              )
          const result = await submitted.promise
          publishSessionSnapshot(result.source)
          if (result.target !== result.source) publishSessionSnapshot(result.target)
          publishSessionUpdated(result.source)
          publishSessionUpdated(result.target)
          return sendJson(res, 200, {
            commandId,
            command: submitted.record,
            replacement: result.replacement,
            sourceSnapshot: sessions.snapshot(result.source),
            targetSnapshot: sessions.snapshot(result.target),
          })
        } catch (error) {
          return handleSessionCmdError(res, error)
        }
      }

      const sessionReplacement = p.match(/^\/api\/v1\/sessions\/([^/]+)\/commands\/(fork|clone|import)$/)
      if (method === "POST" && sessionReplacement) {
        const id = decodeURIComponent(sessionReplacement[1])
        const operation = sessionReplacement[2]
        const body = await readCommandBody<{
          entryId?: string
          position?: "before" | "at"
          inputPath?: string
          cwdOverride?: string
        }>(req)
        try {
          const commandId = resolveCommandId(req, body)
          const submitted = operation === "fork"
            ? sessionExecutor.submit(
                {
                  protocolVersion: 2,
                  commandId,
                  type: "session.fork",
                  concurrency: "idle-only",
                  sessionId: id,
                  payload: {
                    entryId: body.entryId ?? "",
                    position: body.position === "before" ? "before" : "at",
                  },
                },
                () => {
                  if (!body.entryId) throw Object.assign(new Error("entryId required"), { code: "INVALID_REQUEST" })
                  return sessions.forkSession(id, body.entryId, body.position === "before" ? "before" : "at")
                },
              )
            : operation === "clone"
              ? sessionExecutor.submit(
                  {
                    protocolVersion: 2,
                    commandId,
                    type: "session.clone",
                    concurrency: "idle-only",
                    sessionId: id,
                    payload: { entryId: body.entryId },
                  },
                  () => sessions.cloneSession(id, body.entryId),
                )
              : sessionExecutor.submit(
                  {
                    protocolVersion: 2,
                    commandId,
                    type: "session.import",
                    concurrency: "idle-only",
                    sessionId: id,
                    payload: { inputPath: body.inputPath ?? "", cwdOverride: body.cwdOverride },
                  },
                  () => {
                    if (!body.inputPath) throw Object.assign(new Error("inputPath required"), { code: "INVALID_REQUEST" })
                    return sessions.importSession(id, body.inputPath, body.cwdOverride)
                  },
                )
          const result = await submitted.promise
          publishSessionSnapshot(result.source)
          if (result.target !== result.source) publishSessionSnapshot(result.target)
          publishSessionUpdated(result.source)
          publishSessionUpdated(result.target)
          return sendJson(res, 200, {
            commandId,
            command: submitted.record,
            replacement: result.replacement,
            sourceSnapshot: sessions.snapshot(result.source),
            targetSnapshot: sessions.snapshot(result.target),
          })
        } catch (error) {
          return handleSessionCmdError(res, error)
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
        const rec = store.resolve(await ensureDefaultWorkspace())
        return sendJson(res, 200, {
          workspace: {
            path: rec.canonicalRoot,
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
          const rec = store.resolve(body.rootPath, body.displayName)
          return sendJson(res, 201, {
            workspace: {
              path: rec.canonicalRoot,
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
        // A workspace is addressed by its path, URL-encoded so it stays one segment.
        const rest = wsMatch[2] ?? ""
        let ws: WorkspaceRecord
        try {
          ws = store.resolve(decodeURIComponent(wsMatch[1]))
        } catch (e) {
          const code = (e as { code?: string }).code
          if (code === "WORKSPACE_NOT_FOUND") {
            return sendProblem(res, 404, "WORKSPACE_NOT_FOUND", "workspace not found")
          }
          return sendProblem(res, 400, "INVALID_REQUEST", e instanceof Error ? e.message : String(e))
        }

        if (method === "GET" && rest === "") {
          return sendJson(res, 200, {
            workspace: {
              path: ws.canonicalRoot,
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

        if (method === "GET" && rest === "search/text") {
          const q = url.searchParams.get("q") ?? ""
          const limit = Number(url.searchParams.get("limit") ?? 50)
          try {
            const matches = searchWorkspaceText(ws, q, {
              limit: Number.isFinite(limit) ? limit : 50,
            })
            return sendJson(res, 200, { query: q, matches })
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
      if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "INVALID_REQUEST") {
        return sendProblem(res, 400, "INVALID_REQUEST", e instanceof Error ? e.message : String(e))
      }
      if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "SESSION_BUSY") {
        return sendProblem(res, 409, "SESSION_BUSY", e instanceof Error ? e.message : String(e))
      }
      if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "SESSION_RUNTIME_CRASHED") {
        return sendProblem(res, 503, "SESSION_RUNTIME_CRASHED", e instanceof Error ? e.message : String(e))
      }
      const msg = e instanceof Error ? e.message : String(e)
      return sendProblem(res, 500, "INTERNAL", msg)
    }
  })
  bindEventHub(server, eventHub)
  const closeHttpServer = server.close.bind(server)
  let closePromise: Promise<void> | undefined
  server.close = ((callback?: (error?: Error) => void) => {
    closePromise ??= Promise.all([
      new Promise<void>((resolve, reject) => {
        closeHttpServer(error => (error ? reject(error) : resolve()))
      }),
      sessions.dispose(),
    ]).then(() => undefined)
    void closePromise.then(
      () => callback?.(),
      error => callback?.(error instanceof Error ? error : new Error(String(error))),
    )
    return server
  }) as typeof server.close
  return server
}

function handleSessionCmdError(res: ServerResponse, e: unknown) {
  const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : ""
  if (code === "SESSION_NOT_FOUND") {
    return sendProblem(res, 404, "SESSION_NOT_FOUND", "session not found")
  }
  if (code === "WORKSPACE_NOT_FOUND") {
    return sendProblem(res, 404, "WORKSPACE_NOT_FOUND", "workspace not found")
  }
  if (code === "SESSION_BUSY") {
    return sendProblem(res, 409, "SESSION_BUSY", e instanceof Error ? e.message : String(e))
  }
  if (code === "SESSION_RUNTIME_CRASHED" || code === "RUNTIME_REPLACED" || code === "WORKER_RESULT_UNKNOWN") {
    return sendProblem(res, 503, code, e instanceof Error ? e.message : String(e))
  }
  if (code === "SESSION_IDENTITY_MISMATCH") {
    return sendProblem(res, 409, code, e instanceof Error ? e.message : String(e))
  }
  if (code === "FILE_TOO_LARGE") {
    return sendProblem(res, 413, "FILE_TOO_LARGE", e instanceof Error ? e.message : String(e))
  }
  if (code === "NOT_FOUND") {
    return sendProblem(res, 404, code, e instanceof Error ? e.message : String(e))
  }
  if (code === "EXTENSION_UI_CANCELLED" || code === "RESPONSE_CONFLICT") {
    return sendProblem(res, 409, code, e instanceof Error ? e.message : String(e))
  }
  if (code === "PATH_OUTSIDE_WORKSPACE" || code === "SYMLINK_ESCAPE") {
    return sendProblem(res, 403, code, e instanceof Error ? e.message : String(e))
  }
  if (code === "COMMAND_ALREADY_ACCEPTED" || code === "SESSION_CONFLICT") {
    return sendProblem(res, 409, code, e instanceof Error ? e.message : String(e))
  }
  if (code === "CAPABILITY_DISABLED" || code === "MODEL_NOT_AVAILABLE" || code === "SESSION_NOT_RUNNING") {
    return sendProblem(res, 409, code === "SESSION_NOT_RUNNING" ? "SESSION_CONFLICT" : code,
      e instanceof Error ? e.message : String(e))
  }
  if (code === "DRIVER_UNAVAILABLE") {
    return sendProblem(res, 503, code, e instanceof Error ? e.message : String(e))
  }
  if (
    code === "INTERNAL" ||
    code === "SESSION_REPLACEMENT_COMMIT_FAILED" ||
    code === "SESSION_REPLACEMENT_FILE_CONFLICT"
  ) {
    return sendProblem(res, 500, "INTERNAL", e instanceof Error ? e.message : String(e))
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
