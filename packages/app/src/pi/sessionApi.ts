/**
 * PiUI session API client — talks to packages/server /api/v1 only.
 * No OpenCode SDK. No real LLM calls from the browser.
 */

import type { SessionSnapshotV1 } from "@piui/protocol"
import type { PiSessionSummary } from "./toApiSession"
import { trackPiSession, untrackPiSession } from "./piSessionIndex"
import { cacheWorkspace, getWorkspaceIdByPath } from "./workspaceCache"
import { parsePiWorkspaceId } from "./workspaceRef"

const DEFAULT_BASE = "http://127.0.0.1:8787"

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

export async function isPiServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBase()}/api/v1/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

export async function listPiSessions(): Promise<PiSessionSummary[]> {
  const res = await fetch(`${getApiBase()}/api/v1/sessions`)
  if (!res.ok) throw new Error(`listPiSessions ${res.status}`)
  const data = (await res.json()) as { sessions: PiSessionSummary[] }
  for (const s of data.sessions) trackPiSession(s.id)
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
  trackPiSession(data.session.id)
  return { summary: data.session, snapshot: data.snapshot }
}

export async function deletePiSession(sessionId: string): Promise<void> {
  const res = await fetch(`${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  })
  if (!res.ok) throw new Error(`deletePiSession ${res.status}`)
  untrackPiSession(sessionId)
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

export async function abortSessionCommand(sessionId: string): Promise<SessionSnapshotV1 | null> {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/abort`,
    { method: "POST" },
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

/** Mock prompt — server does not call a real LLM. stream=true emits WS snapshots. */
export async function promptSession(
  sessionId: string,
  text: string,
  opts?: { stream?: boolean },
): Promise<SessionSnapshotV1> {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/prompt`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, stream: opts?.stream === true }),
    },
  )
  if (!res.ok) throw new Error(`promptSession ${res.status}`)
  const data = (await res.json()) as { snapshot: SessionSnapshotV1 }
  return data.snapshot
}
