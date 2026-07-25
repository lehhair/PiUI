import type { SessionSnapshotV1 } from "@piui/protocol"
import type { PiSessionSummary, UiSession } from "../types/session"
import { toPiWorkspaceDirectory } from "./workspaceRef"
import { getPathByWorkspaceId } from "./workspaceCache"

function defaultDirectory(workspaceId: string, override?: string): string {
  if (override) return override
  return getPathByWorkspaceId(workspaceId) ?? toPiWorkspaceDirectory(workspaceId)
}

function sessionTimestamps(summary: PiSessionSummary) {
  const parsedCreated = Date.parse(summary.createdAt)
  const parsedUpdated = Date.parse(summary.updatedAt)
  const createdAt = Number.isNaN(parsedCreated) ? (Number.isNaN(parsedUpdated) ? 0 : parsedUpdated) : parsedCreated
  const updatedAt = Number.isNaN(parsedUpdated) ? createdAt : parsedUpdated
  return { createdAt, updatedAt }
}

export function toUiSession(summary: PiSessionSummary, directory?: string): UiSession {
  return {
    id: summary.id,
    workspaceId: summary.workspaceId,
    directory: defaultDirectory(summary.workspaceId, directory ?? summary.directory),
    title: summary.title || "New chat",
    ...sessionTimestamps(summary),
  }
}

export function snapshotToUiSession(snapshot: SessionSnapshotV1, directory?: string): UiSession {
  return toUiSession(
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
