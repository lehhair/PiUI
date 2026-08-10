import type { ExtensionUiDialogRequest, JsonObject } from '@piui/protocol'
import { extensionUiStore } from '../extensionUiStore'
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
    this.restorePendingExtensionUi(sessionId, state)
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
   * 刷新/重连后恢复扩展 dialog：worker 侧 ExtensionUiBridge 的 pending
   * 请求跨刷新存活（扩展仍在阻塞等应答），state.get 把它们带回这里重新
   * 喂给 dialog store——弹窗重新出现，用户可继续应答或取消，会话不会因
   * 无人应答的弹窗而永久卡死。requestOpened / addPendingRequest 都按
   * requestId 幂等，与实时事件重复投递无害；settled 事件会照常清理。
   */
  private restorePendingExtensionUi(sessionId: string, state: JsonObject): void {
    const pending = state.pendingExtensionUiRequests
    if (!Array.isArray(pending)) return
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
}

export const piSessionStateStore = new PiSessionStateStore()
