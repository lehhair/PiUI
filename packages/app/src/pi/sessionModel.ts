import type { SessionSnapshotV1 } from "@piui/protocol"
import type { PiSessionSummary, UiSession } from "../types/session"

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
    directory: directory ?? summary.directory,
    title: summary.title || "New chat",
    path: summary.path,
    parentSessionPath: summary.parentSessionPath,
    ...sessionTimestamps(summary),
  }
}

export function snapshotToUiSession(snapshot: SessionSnapshotV1, directory?: string): UiSession {
  return toUiSession(
    {
      id: snapshot.session.id,
      directory: snapshot.session.directory,
      title: snapshot.session.title ?? "New chat",
      createdAt: snapshot.session.createdAt,
      updatedAt: snapshot.session.updatedAt,
    },
    directory ?? snapshot.session.directory,
  )
}
