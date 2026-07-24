import type { SessionSnapshotV1 } from "@piui/protocol"
import type { ApiSession } from "../api/types"

export interface PiSessionSummary {
  id: string
  workspaceId: string
  title: string
  createdAt: string
  updatedAt: string
}

/** Map Pi session DTO → shape expected by OCUI sidebar. */
export function toApiSession(summary: PiSessionSummary, directory = "piui"): ApiSession {
  const updated = Date.parse(summary.updatedAt) || Date.now()
  const created = Date.parse(summary.createdAt) || updated
  return {
    id: summary.id,
    slug: summary.id.slice(0, 8),
    projectID: summary.workspaceId,
    directory,
    title: summary.title || "New chat",
    version: "piui",
    time: {
      created,
      updated,
    },
  } as ApiSession
}

export function snapshotToApiSession(snapshot: SessionSnapshotV1, directory = "piui"): ApiSession {
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
