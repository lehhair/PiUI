import type { ExtensionUiDialogRequest, ExtensionUiStatePatch, JsonObject } from '@piui/protocol'
import { extensionUiStore } from '../extensionUiStore'
import { extensionTuiStore } from '../extensionTuiStore'
import { activeSessionStore } from '../../store/activeSessionStore'

interface StateEntry {
  state: JsonObject | null
  loading: boolean
  error: Error | null
}

/**
 * Raw session runtime state store, keyed by session id (multi-pane safe).
 * Follows app store convention: subscribe/notify + stable snapshots.
 */
class PiSessionStateStore {
  private bySessionId = new Map<string, StateEntry>()
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(l => l())
  }

  private entry(sessionId: string): StateEntry {
    let entry = this.bySessionId.get(sessionId)
    if (!entry) {
      entry = { state: null, loading: false, error: null }
      this.bySessionId.set(sessionId, entry)
    }
    return entry
  }

  setLoading(sessionId: string, loading: boolean): void {
    this.entry(sessionId).loading = loading
    this.notify()
  }

  setState(sessionId: string, state: JsonObject): void {
    const entry = this.entry(sessionId)
    entry.state = state
    entry.error = null
    entry.loading = false
    this.restoreExtensionUi(sessionId, state)
    this.notify()
  }

  setError(sessionId: string, error: Error): void {
    const entry = this.entry(sessionId)
    entry.error = error
    entry.loading = false
    this.notify()
  }

  getState(sessionId: string): JsonObject | null {
    return this.bySessionId.get(sessionId)?.state ?? null
  }

  isLoading(sessionId: string): boolean {
    return this.bySessionId.get(sessionId)?.loading ?? false
  }

  getError(sessionId: string): Error | null {
    return this.bySessionId.get(sessionId)?.error ?? null
  }

  clear(sessionId: string): void {
    this.bySessionId.delete(sessionId)
    this.notify()
  }

  clearAll(): void {
    this.bySessionId.clear()
    this.notify()
  }

  /**
   * 刷新/重连后恢复扩展 UI：worker 侧的未应答 dialog 请求 + 增量状态镜像
   * 都跨刷新存活（扩展仍在阻塞/状态仍在推进），state.get 把它们带回这里
   * 重新喂给对应 store——弹窗重新出现、status/widget 指示重建，会话不会
   * 因无人应答的弹窗而永久卡死，显示也不会因刷新归零。requestOpened /
   * addPendingRequest / restore 都按 requestId 或覆盖式语义幂等，与实时
   * 事件重复投递无害；settled 事件会照常清理。
   */
  private restoreExtensionUi(sessionId: string, state: JsonObject): void {
    const pending = state.pendingExtensionUiRequests
    if (Array.isArray(pending)) {
      for (const raw of pending) {
        const request = raw as Partial<ExtensionUiDialogRequest> | null
        if (!request || typeof request !== 'object' || typeof request.requestId !== 'string') continue
        if (typeof request.sessionId === 'string' && request.sessionId !== sessionId) continue
        if (!request.kind || !['select', 'confirm', 'input', 'editor'].includes(request.kind)) continue
        extensionUiStore.requestOpened(request as ExtensionUiDialogRequest)
        activeSessionStore.addPendingRequest(
          request.requestId,
          sessionId,
          request.kind === 'confirm' ? 'permission' : 'question',
          request.title,
        )
      }
    }
    const mirror = state.extensionUiState as { patches?: unknown; editorText?: unknown } | null | undefined
    if (mirror && typeof mirror === 'object' && Array.isArray(mirror.patches)) {
      extensionUiStore.restore(sessionId, {
        patches: mirror.patches as ExtensionUiStatePatch[],
        editorText: typeof mirror.editorText === 'string' ? mirror.editorText : '',
        toolsExpanded: mirror.toolsExpanded === true,
      })
    }
    // offscreen 扩展 TUI 面板：组件在 worker 侧仍挂着，用全量快照替换恢复
    //（之后的新 attach/detach 实时事件继续增量修正），ExtensionTuiView
    // 挂载时自动请求一次全量重绘取回画面。
    const tuiPanels = state.extensionTuiPanels
    if (Array.isArray(tuiPanels)) {
      const attaches = tuiPanels.filter(raw => {
        const attach = raw as { key?: unknown; kind?: unknown } | null
        return attach !== null && typeof attach === 'object' && typeof attach.key === 'string' && typeof attach.kind === 'string'
      }) as never[]
      extensionTuiStore.replacePanels(sessionId, attaches)
    }
  }
}

export const piSessionStateStore = new PiSessionStateStore()
