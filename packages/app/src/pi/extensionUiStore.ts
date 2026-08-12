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

/** editorText 的来源：'mirror' 是 state 刷新/重连恢复的 worker 镜像，
 *  'extension' 是扩展真实发出的 editor set/paste 事件。桥接层据此判断
 *  回填是否会覆盖用户正在输入的更新文本。 */
type EditorTextSource = 'none' | 'mirror' | 'extension'

const editorTextSourceBySession = new Map<string, EditorTextSource>()

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

  /**
   * 刷新/重连恢复：重放 worker 侧状态镜像（status/widget/working 指示等
   * 增量 patch），重建显示。覆盖式 patch 全量重放幂等，多次恢复无害；
   * 只重建 state，不动 pending（实时 dialog 事件可能已先到）。
   * 注意：state 刷新每次都会调用这里，editorText 标记为 'mirror' 来源，
   * 桥接层只在输入框没有更新文本时才允许它回填（详见 PiChatPane）。
   */
  restore(
    sessionId: string,
    mirror: { patches: ExtensionUiStatePatch[]; editorText: string; toolsExpanded: boolean },
  ): void {
    const snapshot = existing(sessionId)
    let state = emptyState()
    for (const patch of mirror.patches) state = applyStatePatch(state, patch)
    editorTextSourceBySession.set(sessionId, 'mirror')
    update(sessionId, {
      ...snapshot,
      state: { ...state, editorText: mirror.editorText },
    })
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
    editorTextSourceBySession.set(sessionId, 'extension')
    update(sessionId, {
      ...snapshot,
      state: { ...snapshot.state, revision: snapshot.state.revision + 1, editorText },
    })
  },

  remove(sessionId: string): void {
    if (!(sessionId in current.sessions)) return
    const sessions = { ...current.sessions }
    delete sessions[sessionId]
    editorTextSourceBySession.delete(sessionId)
    current = { sessions }
    for (const listener of listeners) listener()
  },

  reset(): void {
    current = { sessions: {} }
    editorTextSourceBySession.clear()
    for (const listener of listeners) listener()
  },
}

export function getEditorTextSource(sessionId: string | null | undefined): EditorTextSource {
  return sessionId ? (editorTextSourceBySession.get(sessionId) ?? 'none') : 'none'
}
