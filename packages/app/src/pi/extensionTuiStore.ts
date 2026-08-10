import type { ExtensionTuiAttach } from '@piui/protocol'

/**
 * Offscreen extension TUI mirror state: which panels (component widgets,
 * custom(), footer, header) are attached per session, plus a frame bus that
 * delivers raw ANSI frames straight to xterm.js views without triggering
 * React re-renders.
 */

export type ExtensionTuiPanel = {
  key: string
  kind: 'widget' | 'custom' | 'footer' | 'header'
  placement?: 'aboveEditor' | 'belowEditor'
  width: number
  height: number
}

interface ExtensionTuiStoreSnapshot {
  sessions: Readonly<Record<string, { panels: ExtensionTuiPanel[] }>>
}

type FrameListener = (sessionId: string, data: string) => void

let current: ExtensionTuiStoreSnapshot = { sessions: {} }
const listeners = new Set<() => void>()
const frameListeners = new Set<FrameListener>()

function emit(): void {
  for (const listener of listeners) listener()
}

function updateSession(sessionId: string, session: { panels: ExtensionTuiPanel[] }): void {
  current = { sessions: { ...current.sessions, [sessionId]: session } }
  emit()
}

export const extensionTuiStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  getSnapshot(): ExtensionTuiStoreSnapshot {
    return current
  },

  /** Subscribe to raw ANSI frames; called per frame with (sessionId, data). */
  subscribeFrames(listener: FrameListener): () => void {
    frameListeners.add(listener)
    return () => frameListeners.delete(listener)
  },

  attach(sessionId: string, attach: ExtensionTuiAttach): void {
    const session = current.sessions[sessionId] ?? { panels: [] }
    const panels = session.panels.filter(panel => panel.key !== attach.key)
    updateSession(sessionId, {
      panels: [
        ...panels,
        {
          key: attach.key,
          kind: attach.kind,
          placement: attach.placement,
          width: attach.width,
          height: attach.height,
        },
      ],
    })
  },

  detach(sessionId: string, key: string): void {
    const session = current.sessions[sessionId]
    if (!session) return
    updateSession(sessionId, { panels: session.panels.filter(panel => panel.key !== key) })
  },

  /**
   * 刷新/重连恢复：用 worker 侧全量快照替换该 session 的面板集合
   * （快照是权威基线；之后的新 attach/detach 实时事件继续增量修正）。
   */
  replacePanels(sessionId: string, attaches: ExtensionTuiAttach[]): void {
    updateSession(sessionId, {
      panels: attaches.map(attach => ({
        key: attach.key,
        kind: attach.kind,
        placement: attach.placement,
        width: attach.width,
        height: attach.height,
      })),
    })
  },

  frame(sessionId: string, data: string): void {
    for (const listener of frameListeners) listener(sessionId, data)
  },

  remove(sessionId: string): void {
    if (!(sessionId in current.sessions)) return
    const sessions = { ...current.sessions }
    delete sessions[sessionId]
    current = { sessions }
    emit()
  },

  reset(): void {
    current = { sessions: {} }
    emit()
  },
}
