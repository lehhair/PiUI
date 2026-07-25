import type { SessionSnapshotV1 } from "@piui/protocol"
import { messageStore } from "../store/messageStore"
import { sessionProjectionStore } from "./sessionProjectionStore"
import { trackPiSession } from "./piSessionIndex"
import { snapshotToApiMessages } from "./timelineToMessages"

/** Push Pi snapshot into legacy messageStore so ChatArea can render. */
export function applySnapshotToUi(snapshot: SessionSnapshotV1, options?: { activate?: boolean }) {
  trackPiSession(snapshot.session.id)
  if (!sessionProjectionStore.replace(snapshot, options)) return snapshot.session.id
  const apiMessages = snapshotToApiMessages(snapshot)
  messageStore.setMessages(snapshot.session.id, apiMessages, {
    title: snapshot.session.title,
    hasMoreHistory: false,
  })
  return snapshot.session.id
}
