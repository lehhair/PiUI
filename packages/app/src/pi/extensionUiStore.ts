import type {
  ExtensionUiDialogRequestV1,
  ExtensionUiEditorCommandV1,
  ExtensionUiSnapshotV1,
  ExtensionUiStateV1,
} from "@piui/protocol"

interface ExtensionUiStoreSnapshot {
  sessions: Readonly<Record<string, ExtensionUiSnapshotV1>>
}

const emptyState = (): ExtensionUiStateV1 => ({
  revision: 0,
  statuses: {},
  workingVisible: true,
  widgets: {},
  editorText: "",
  toolsExpanded: false,
})

let current: ExtensionUiStoreSnapshot = { sessions: {} }
const listeners = new Set<() => void>()

function update(sessionId: string, value: ExtensionUiSnapshotV1): void {
  current = { sessions: { ...current.sessions, [sessionId]: value } }
  for (const listener of listeners) listener()
}

function existing(sessionId: string): ExtensionUiSnapshotV1 {
  return current.sessions[sessionId] ?? { sessionId, state: emptyState(), pending: [] }
}

export const extensionUiStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  getSnapshot(): ExtensionUiStoreSnapshot {
    return current
  },

  replace(snapshot: ExtensionUiSnapshotV1): void {
    update(snapshot.sessionId, structuredClone(snapshot))
  },

  requestOpened(request: ExtensionUiDialogRequestV1): void {
    const snapshot = existing(request.sessionId)
    update(request.sessionId, {
      ...snapshot,
      workerGeneration: request.workerGeneration ?? snapshot.workerGeneration,
      pending: [...snapshot.pending.filter(item => item.requestId !== request.requestId), structuredClone(request)],
    })
  },

  requestSettled(sessionId: string, requestId: string): void {
    const snapshot = existing(sessionId)
    update(sessionId, { ...snapshot, pending: snapshot.pending.filter(item => item.requestId !== requestId) })
  },

  stateUpdated(sessionId: string, state: ExtensionUiStateV1): void {
    update(sessionId, { ...existing(sessionId), state: structuredClone(state) })
  },

  editorCommand(sessionId: string, command: ExtensionUiEditorCommandV1): void {
    const snapshot = existing(sessionId)
    const editorText = command.kind === "set"
      ? command.text
      : snapshot.state.editorText + command.text
    update(sessionId, {
      ...snapshot,
      state: { ...snapshot.state, revision: snapshot.state.revision + 1, editorText },
    })
  },

  remove(sessionId: string): void {
    if (!(sessionId in current.sessions)) return
    const sessions = { ...current.sessions }
    delete sessions[sessionId]
    current = { sessions }
    for (const listener of listeners) listener()
  },

  reset(): void {
    current = { sessions: {} }
    for (const listener of listeners) listener()
  },
}
