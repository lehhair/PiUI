import type {
  ExtensionUiDialogRequest,
  ExtensionUiEditorCommand,
  ExtensionUiSnapshot,
  ExtensionUiState,
  ExtensionUiStatePatch,
} from "@piui/protocol"

interface ExtensionUiStoreSnapshot {
  sessions: Readonly<Record<string, ExtensionUiSnapshot>>
}

const emptyState = (): ExtensionUiState => ({
  revision: 0,
  statuses: {},
  workingVisible: true,
  widgets: {},
  editorText: "",
  toolsExpanded: false,
})

function applyStatePatch(state: ExtensionUiState, patch: ExtensionUiStatePatch): ExtensionUiState {
  const revision = state.revision + 1
  switch (patch.kind) {
    case 'status': {
      const statuses = { ...state.statuses }
      if (patch.text === undefined) delete statuses[patch.key]
      else statuses[patch.key] = patch.text
      return { ...state, revision, statuses }
    }
    case 'workingMessage':
      return { ...state, revision, workingMessage: patch.message }
    case 'workingVisible':
      return { ...state, revision, workingVisible: patch.visible }
    case 'workingIndicator':
      return {
        ...state,
        revision,
        workingIndicator: patch.frames ? { frames: patch.frames, intervalMs: patch.intervalMs ?? 100 } : undefined,
      }
    case 'hiddenThinkingLabel':
      return { ...state, revision, hiddenThinkingLabel: patch.label }
    case 'widget': {
      const widgets = { ...state.widgets }
      if (!patch.lines) delete widgets[patch.key]
      else widgets[patch.key] = { lines: patch.lines, placement: patch.placement ?? 'aboveEditor' }
      return { ...state, revision, widgets }
    }
    case 'title':
      return { ...state, revision, title: patch.title }
    case 'theme':
      return { ...state, revision, themeName: patch.name }
    case 'toolsExpanded':
      return { ...state, revision, toolsExpanded: patch.expanded }
  }
}

let current: ExtensionUiStoreSnapshot = { sessions: {} }
const listeners = new Set<() => void>()

function update(sessionId: string, value: ExtensionUiSnapshot): void {
  current = { sessions: { ...current.sessions, [sessionId]: value } }
  for (const listener of listeners) listener()
}

function existing(sessionId: string): ExtensionUiSnapshot {
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

  replace(snapshot: ExtensionUiSnapshot): void {
    update(snapshot.sessionId, structuredClone(snapshot))
  },

  requestOpened(request: ExtensionUiDialogRequest): void {
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

  statePatched(sessionId: string, patch: ExtensionUiStatePatch): void {
    const snapshot = existing(sessionId)
    update(sessionId, { ...snapshot, state: applyStatePatch(snapshot.state, patch) })
  },

  editorCommand(sessionId: string, command: ExtensionUiEditorCommand): void {
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
