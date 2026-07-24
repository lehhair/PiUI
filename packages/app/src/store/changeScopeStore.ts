import { useCallback, useSyncExternalStore } from 'react'

export type ChangeScopeMode = 'git' | 'branch' | 'session' | 'turn'

type Subscriber = () => void

class ChangeScopeStore {
  private modes = new Map<string, ChangeScopeMode>()
  private subscribers = new Set<Subscriber>()

  subscribe = (fn: Subscriber): (() => void) => {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  getMode(sessionId: string | null): ChangeScopeMode {
    if (!sessionId) return 'turn'
    return this.modes.get(sessionId) ?? 'turn'
  }

  setMode(sessionId: string | null, mode: ChangeScopeMode) {
    if (!sessionId) return
    if (this.modes.get(sessionId) === mode) return
    this.modes.set(sessionId, mode)
    this.subscribers.forEach(fn => fn())
  }

  clearSession(sessionId: string | null) {
    if (!sessionId) return
    if (!this.modes.delete(sessionId)) return
    this.subscribers.forEach(fn => fn())
  }

  clearAll() {
    if (this.modes.size === 0) return
    this.modes.clear()
    this.subscribers.forEach(fn => fn())
  }
}

export const changeScopeStore = new ChangeScopeStore()

export function useSessionChangeScope(sessionId: string | null): ChangeScopeMode {
  const getSnapshot = useCallback(() => changeScopeStore.getMode(sessionId), [sessionId])
  return useSyncExternalStore(changeScopeStore.subscribe, getSnapshot, getSnapshot)
}
