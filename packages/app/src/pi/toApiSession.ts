import type { SessionSnapshotV1 } from "@piui/protocol"
import type { ApiSession } from "../api/types"
import { toPiWorkspaceDirectory } from "./workspaceRef"
import { getPathByWorkspaceId } from "./workspaceCache"

export interface PiSessionSummary {
  id: string
  workspaceId: string
  title: string
  createdAt: string
  updatedAt: string
}

function defaultDirectory(workspaceId: string, override?: string): string {
  if (override) return override
  return getPathByWorkspaceId(workspaceId) ?? toPiWorkspaceDirectory(workspaceId)
}

/** Map Pi session DTO → shape expected by OCUI sidebar. */
export function toApiSession(summary: PiSessionSummary, directory?: string): ApiSession {
  const updated = Date.parse(summary.updatedAt) || Date.now()
  const created = Date.parse(summary.createdAt) || updated
  return {
    id: summary.id,
    slug: summary.id.slice(0, 8),
    projectID: summary.workspaceId,
    directory: defaultDirectory(summary.workspaceId, directory),
    title: summary.title || "New chat",
    version: "piui",
    time: {
      created,
      updated,
    },
  } as ApiSession
}

export function snapshotToApiSession(snapshot: SessionSnapshotV1, directory?: string): ApiSession {
  return toApiSession(
    {
      id: snapshot.session.id,
      workspaceId: snapshot.session.workspaceId,
      title: snapshot.session.title ?? "New chat",
      createdAt: snapshot.session.createdAt,
      updatedAt: snapshot.session.updatedAt,
    },
    directory,
  )
}
