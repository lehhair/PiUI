import type { SessionSnapshotV1 } from "@piui/protocol"
import { messageStore } from "../store/messageStore"
import { sessionProjectionStore } from "./sessionProjectionStore"
import { trackPiSession } from "./piSessionIndex"
import { snapshotToUiMessages } from "./timelineToMessages"

/** Push a Pi snapshot into the UI stores consumed by ChatArea. */
export function applySnapshotToUi(snapshot: SessionSnapshotV1, options?: { activate?: boolean }) {
  trackPiSession(snapshot.session.id, snapshot.session.workspaceId)
  if (!sessionProjectionStore.replace(snapshot, options)) return snapshot.session.id
  const messages = snapshotToUiMessages(snapshot)
  messageStore.setUiMessages(snapshot.session.id, messages, {
    title: snapshot.session.title,
    hasMoreHistory: false,
  })
  messageStore.setStreaming(
    snapshot.session.id,
    snapshot.runtime.isStreaming,
  )
  return snapshot.session.id
}
