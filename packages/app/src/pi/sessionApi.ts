/**
 * PiUI session API client — talks to packages/server /api/v1 only.
 * No OpenCode SDK. No real LLM calls from the browser.
 */

import type { SessionSnapshotV1 } from "@piui/protocol"
import type { PiSessionSummary } from "./toApiSession"
import { trackPiSession, untrackPiSession } from "./piSessionIndex"

const DEFAULT_BASE = "http://127.0.0.1:8787"

export function getApiBase(): string {
  return (import.meta as ImportMeta & { env?: { VITE_PIUI_API?: string } }).env?.VITE_PIUI_API ?? DEFAULT_BASE
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
}): Promise<{ summary: PiSessionSummary; snapshot: SessionSnapshotV1 }> {
  const res = await fetch(`${getApiBase()}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: opts?.title, seedMock: opts?.seedMock === true }),
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
  const res = await fetch(`${getApiBase()}/api/v1/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rootPath, displayName }),
  })
  if (!res.ok) throw new Error(`createWorkspace ${res.status}`)
  return (await res.json()) as { workspace: { id: string; displayName: string } }
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

/** Mock prompt — server does not call a real LLM. */
export async function promptSession(sessionId: string, text: string): Promise<SessionSnapshotV1> {
  const res = await fetch(
    `${getApiBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands/prompt`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  )
  if (!res.ok) throw new Error(`promptSession ${res.status}`)
  const data = (await res.json()) as { snapshot: SessionSnapshotV1 }
  return data.snapshot
}
