import type { JsonObject } from '@piui/protocol'

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
}

export const piSessionStateStore = new PiSessionStateStore()
