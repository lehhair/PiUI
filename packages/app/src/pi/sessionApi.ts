/**
 * PiUI session API client — talks to packages/server /api/v1 only.
 * No OpenCode SDK. No real LLM calls from the browser.
 */

import type {
  CommandRecordV2,
  SessionReplacementResultV1,
  SessionSnapshotV1,
} from "@piui/protocol"
import type { PiSessionSummary } from "../types/session"
import { trackPiSession, untrackPiSession } from "./piSessionIndex"
import { cacheWorkspace, getWorkspaceIdByPath } from "./workspaceCache"
import { parsePiWorkspaceId } from "./workspaceRef"
import { sessionProjectionStore } from "./sessionProjectionStore"

const DEFAULT_BASE = "http://127.0.0.1:8787"
const rawFetch = globalThis.fetch.bind(globalThis)

function newCommandId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Browser dev uses same-origin + Vite proxy (`/api` → :8787) to avoid CORS.
 * Override with VITE_PIUI_API when needed.
 */
export function getApiBase(): string {
  const envBase = (import.meta as ImportMeta & { env?: { VITE_PIUI_API?: string } }).env?.VITE_PIUI_API
  if (envBase) return envBase.replace(/\/$/, "")
  if (typeof window !== "undefined") return ""
  return DEFAULT_BASE
}

function piHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init)
  const token = (import.meta as ImportMeta & { env?: { VITE_PIUI_TOKEN?: string } }).env?.VITE_PIUI_TOKEN
  if (token) headers.set("authorization", `Bearer ${token}`)
  return headers
}

export function getPiAuthToken(): string | undefined {
  return (import.meta as ImportMeta & { env?: { VITE_PIUI_TOKEN?: string } }).env?.VITE_PIUI_TOKEN
}

export function piFetch(input: string, init?: RequestInit): Promise<Response> {
  return rawFetch(input, { ...init, headers: piHeaders(init?.headers) })
}

// Keep the rest of this transitional client on one authenticated transport.
const fetch = piFetch

export async function isPiServerUp(): Promise<boolean> {
  try {
    const res = await piFetch(`${getApiBase()}/api/v1/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const body = (await res.json()) as { service?: string; protocolVersion?: number }
    return body.service === "piui-server" && body.protocolVersion === 1
  } catch {
    return false
  }
}

export interface PiModelDto {
  id: string
  name: string
  providerId: string
  providerName: string
  family: string
  contextLimit: number
  outputLimit: number
  supportsReasoning: boolean
  supportsImages: boolean
  supportsPdf: boolean
  supportsAudio: boolean
  supportsVideo: boolean
  supportsToolcall: boolean
  variants: string[]
}

export async function listPiModels(): Promise<{
  driver: string
  models: PiModelDto[]
  error?: string
}> {
  const res = await fetch(`${getApiBase()}/api/v1/drivers/pi/models`)
  if (!res.ok) throw new Error(`listPiModels ${res.status}`)
  return (await res.json()) as { driver: string; models: PiModelDto[]; error?: string }
}

export async function listPiSessions(workspaceId?: string): Promise<PiSessionSummary[]> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""
  const res = await fetch(`${getApiBase()}/api/v1/sessions${query}`)
  if (!res.ok) throw new Error(`listPiSessions ${res.status}`)
  const data = (await res.json()) as { sessions: PiSessionSummary[] }
  for (const s of data.sessions) trackPiSession(s.id, s.workspaceId)
  return data.sessions
}

export async function createPiSession(opts?: {
  title?: string
  seedMock?: boolean
  workspaceId?: string
}): Promise<{ summary: PiSessionSummary; snapshot: SessionSnapshotV1 }> {
  const res = await fetch(`${getApiBase()}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: opts?.title,
      seedMock: opts?.seedMock === true,
      workspaceId: opts?.workspaceId,
    }),
  })
  if (!res.ok) throw new Error(`createPiSession ${res.status}`)
  const data = (await res.json()) as { session: PiSessionSummary; snapshot: SessionSnapshotV1 }
  trackPiSession(data.session.id, data.session.workspaceId)
  return { summary: data.session, snapshot: data.snapshot }
}

export async function deletePiSession(sessionId: string): Promise<{
  ok: true
  id: string
  commandId: string
  command: CommandRecordV2<"session.delete">
}> {
  const res = await fetch(`${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  })
  if (!res.ok) {
    let code: string | undefined
    try {
      code = ((await res.json()) as { code?: string }).code
    } catch {
      /* no structured error body */
    }
    throw Object.assign(new Error(`deletePiSession ${res.status}`), { status: res.status, code })
  }
  const result = (await res.json()) as {
    ok: true
    id: string
    commandId: string
    command: CommandRecordV2<"session.delete">
  }
  untrackPiSession(sessionId)
  sessionProjectionStore.clear(sessionId)
  return result
}

export async function createWorkspace(rootPath: string, displayName?: string) {
  const cached = getWorkspaceIdByPath(rootPath)
  if (cached) return { workspace: { id: cached, displayName: displayName ?? rootPath } }

  const res = await fetch(`${getApiBase()}/api/v1/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rootPath, displayName }),
  })
  if (!res.ok) throw new Error(`createWorkspace ${res.status}`)
  const data = (await res.json()) as { workspace: { id: string; displayName: string } }
  cacheWorkspace(rootPath, data.workspace.id)
  return data
}

let defaultWorkspacePromise: Promise<string | null> | null = null

async function ensureDefaultWorkspaceId(): Promise<string | null> {
  if (!defaultWorkspacePromise) {
    defaultWorkspacePromise = (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/v1/workspaces/default`)
        if (!res.ok) return null
        const data = (await res.json()) as { workspace: { id: string } }
        return data.workspace.id
      } catch {
        return null
      } finally {
        // allow retry later if failed
      }
    })()
  }
  const id = await defaultWorkspacePromise
  if (!id) defaultWorkspacePromise = null
  return id
}

/** Resolve workspace id from absolute path, piws:id, or default workspace. */
export async function resolveWorkspaceId(directory?: string): Promise<string | null> {
  if (directory) {
    const fromMarker = parsePiWorkspaceId(directory)
    if (fromMarker) return fromMarker
    // absolute path
    if (/^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith("/")) {
      const { workspace } = await createWorkspace(directory)
      return workspace.id
    }
  }
  // empty / global mode: still allow file tree against default workspace
  return ensureDefaultWorkspaceId()
}

export async function listWorkspaceFiles(workspaceId: string, path = "") {
  const q = new URLSearchParams()
  if (path && path !== "." && path !== "./") q.set("path", path)
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files?${q}`,
  )
  if (!res.ok) throw new Error(`listWorkspaceFiles ${res.status}`)
  return (await res.json()) as {
    path: string
    entries: Array<{
      name: string
      path: string
      type: string
      size?: number
      mtimeMs?: number
      restricted?: boolean
    }>
  }
}

export async function readWorkspaceFile(workspaceId: string, path: string) {
  const q = new URLSearchParams({ path })
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/file?${q}`,
  )
  if (!res.ok) throw new Error(`readWorkspaceFile ${res.status}`)
  return (await res.json()) as {
    path: string
    content: string
    encoding: "utf-8"
    size: number
    etag: string
  }
}

export async function searchWorkspaceFiles(
  workspaceId: string,
  query: string,
  opts?: { type?: "file" | "directory"; limit?: number },
): Promise<string[]> {
  const q = new URLSearchParams({ q: query })
  if (opts?.type) q.set("type", opts.type)
  if (opts?.limit) q.set("limit", String(opts.limit))
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/search/files?${q}`,
  )
  if (!res.ok) throw new Error(`searchWorkspaceFiles ${res.status}`)
  const data = (await res.json()) as { paths: string[] }
  return data.paths
}

export async function searchWorkspaceText(workspaceId: string, pattern: string, limit = 50) {
  const q = new URLSearchParams({ q: pattern, limit: String(limit) })
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/search/text?${q}`,
  )
  if (!res.ok) throw new Error(`searchWorkspaceText ${res.status}`)
  const data = (await res.json()) as {
    matches: Array<{
      path: { text: string }
      lines: { text: string }
      line_number: number
      absolute_offset: number
      submatches: Array<{ start: number; end: number; match: { text: string } }>
    }>
  }
  return data.matches
}

export async function writeWorkspaceFile(
  workspaceId: string,
  path: string,
  content: string,
  ifMatch?: string,
) {
  const q = new URLSearchParams({ path })
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/file?${q}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(ifMatch ? { "if-match": ifMatch } : {}),
      },
      body: JSON.stringify({ content, ifMatch }),
    },
  )
  if (!res.ok) throw new Error(`writeWorkspaceFile ${res.status}`)
  return (await res.json()) as {
    path: string
    content: string
    encoding: "utf-8"
    size: number
    etag: string
  }
}

export async function getWorkspaceGitStatus(workspaceId: string) {
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/git/status`,
  )
  if (!res.ok) throw new Error(`getWorkspaceGitStatus ${res.status}`)
  return (await res.json()) as {
    branch: string | null
    ahead: number
    behind: number
    items: Array<{ path: string; status: string; added?: number; removed?: number }>
  }
}

export async function getWorkspaceGitInfo(workspaceId: string) {
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/git/info`,
  )
  if (!res.ok) throw new Error(`getWorkspaceGitInfo ${res.status}`)
  return (await res.json()) as {
    branch: string | null
    root: boolean
    ahead: number
    behind: number
  }
}

export async function getWorkspaceGitDiff(workspaceId: string, mode: "git" | "branch") {
  const q = new URLSearchParams({ mode })
  const res = await fetch(
    `${getApiBase()}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/git/diff?${q}`,
  )
  if (!res.ok) throw new Error(`getWorkspaceGitDiff ${res.status}`)
  return (await res.json()) as {
    mode: string
    files: Array<{ file: string; status: string; additions: number; deletions: number }>
  }
}

export async function setSessionModel(sessionId: string, provider: string, modelId: string) {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/set-model`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, id: modelId }),
    },
  )
  if (!res.ok) throw new Error(`setSessionModel ${res.status}`)
  const data = (await res.json()) as { snapshot: SessionSnapshotV1 }
  return data.snapshot
}

export async function setSessionThinkingLevel(sessionId: string, level: string) {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/set-thinking-level`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level }),
    },
  )
  if (!res.ok) throw new Error(`setSessionThinkingLevel ${res.status}`)
  const data = (await res.json()) as { snapshot: SessionSnapshotV1 }
  return data.snapshot
}

interface SessionCommandResult<T extends keyof import("@piui/protocol").CommandPayloadsV2> {
  commandId: string
  command: CommandRecordV2<T>
}

export interface SessionReplacementResponse<T extends "session.fork" | "session.clone" | "session.import">
  extends SessionCommandResult<T> {
  replacement: SessionReplacementResultV1
  sourceSnapshot: SessionSnapshotV1
  targetSnapshot: SessionSnapshotV1
}

async function postSessionCommand<T>(sessionId: string, command: string, body: unknown): Promise<T> {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/${command}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) throw new Error(`${command} ${res.status}`)
  return (await res.json()) as T
}

export function navigatePiSessionTree(
  sessionId: string,
  entryId: string,
  summarize = false,
  commandId = newCommandId(),
) {
  return postSessionCommand<
    SessionCommandResult<"session.navigateTree"> & {
      editorText?: string
      cancelled: boolean
      aborted: boolean
      snapshot: SessionSnapshotV1
    }
  >(sessionId, "navigate-tree", { entryId, summarize, commandId })
}

export function setPiSessionLabel(
  sessionId: string,
  entryId: string,
  label?: string,
  commandId = newCommandId(),
) {
  return postSessionCommand<SessionCommandResult<"session.setLabel"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "set-label",
    { entryId, label, commandId },
  )
}

export function setPiSessionName(sessionId: string, name: string, commandId = newCommandId()) {
  return postSessionCommand<SessionCommandResult<"session.setName"> & { snapshot: SessionSnapshotV1 }>(
    sessionId,
    "set-name",
    { name, commandId },
  )
}

export function forkPiSession(
  sessionId: string,
  entryId: string,
  position: "before" | "at" = "at",
  commandId = newCommandId(),
) {
  return postSessionCommand<SessionReplacementResponse<"session.fork">>(sessionId, "fork", {
    entryId,
    position,
    commandId,
  })
}

export function clonePiSession(sessionId: string, entryId?: string, commandId = newCommandId()) {
  return postSessionCommand<SessionReplacementResponse<"session.clone">>(sessionId, "clone", {
    entryId,
    commandId,
  })
}

export function importPiSession(
  sessionId: string,
  inputPath: string,
  cwdOverride?: string,
  commandId = newCommandId(),
) {
  return postSessionCommand<SessionReplacementResponse<"session.import">>(sessionId, "import", {
    inputPath,
    cwdOverride,
    commandId,
  })
}

export async function compactSession(sessionId: string, instructions?: string, commandId = newCommandId()) {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/compact`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions, commandId }),
    },
  )
  if (!res.ok) {
    let detail = String(res.status)
    try {
      const err = (await res.json()) as { message?: string; code?: string }
      detail = err.message || err.code || detail
    } catch {
      /* */
    }
    if (res.status === 404) {
      throw new Error(
        "会话在服务端不存在（可能重启过 server）。请点「新建会话」后再 /compact",
      )
    }
    // Pi: empty/small session is not a hard failure
    if (/nothing to compact/i.test(detail)) {
      console.info("[PiUI] compact skipped:", detail)
      return fetchSnapshot(sessionId)
    }
    throw new Error(`compactSession failed: ${detail}`)
  }
  const data = (await res.json()) as { snapshot: SessionSnapshotV1 }
  return data.snapshot
}

export async function listSessionCommands(sessionId: string) {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/pi/commands`,
  )
  if (!res.ok) throw new Error(`listSessionCommands ${res.status}`)
  return (await res.json()) as {
    commands: Array<{ name: string; description?: string; source: string }>
  }
}

export async function listSessionSkills(sessionId: string) {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/pi/skills`,
  )
  if (!res.ok) throw new Error(`listSessionSkills ${res.status}`)
  return (await res.json()) as {
    skills: Array<{ name: string; description?: string; source?: string }>
  }
}

export async function abortSessionCommand(sessionId: string, commandId = newCommandId()): Promise<SessionSnapshotV1 | null> {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/abort`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId }),
    },
  )
  if (!res.ok) return null
  const data = (await res.json()) as { snapshot?: SessionSnapshotV1 }
  return data.snapshot ?? null
}

export async function createMockSession(workspaceId: string, title?: string) {
  const res = await fetch(`${getApiBase()}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, title, seedMock: true }),
  })
  if (!res.ok) throw new Error(`createMockSession ${res.status}`)
  return (await res.json()) as { snapshot: SessionSnapshotV1 }
}

export async function fetchSnapshot(sessionId: string): Promise<SessionSnapshotV1> {
  const res = await fetch(`${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`)
  if (!res.ok) throw new Error(`fetchSnapshot ${res.status}`)
  return (await res.json()) as SessionSnapshotV1
}

/** Prompt session. stream=true emits WS snapshots. Real driver may call LLM. */
export async function promptSession(
  sessionId: string,
  text: string,
  opts?: {
    stream?: boolean
    model?: { providerID: string; modelID: string }
    deliverAs?: "steer" | "followUp"
    commandId?: string
  },
): Promise<SessionSnapshotV1> {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/prompt`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        commandId: opts?.commandId ?? newCommandId(),
        stream: opts?.stream === true,
        deliverAs: opts?.deliverAs,
        model: opts?.model
          ? { provider: opts.model.providerID, id: opts.model.modelID }
          : undefined,
      }),
    },
  )
  if (!res.ok) {
    let detail = String(res.status)
    try {
      const err = (await res.json()) as { message?: string; code?: string }
      detail = err.message || err.code || detail
    } catch {
      /* */
    }
    throw new Error(`promptSession failed: ${detail}`)
  }
  const data = (await res.json()) as { snapshot: SessionSnapshotV1 }
  return data.snapshot
}
