import type { JsonObject } from '@piui/protocol'

/**
 * Raw session runtime state store.
 * Stores state.get result for active session.
 * Follows app store convention: subscribe/notify + stable snapshots.
 */
class PiSessionStateStore {
  private state: JsonObject | null = null
  private loading = false
  private error: Error | null = null
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(l => l())
  }

  setLoading(loading: boolean): void {
    this.loading = loading
    this.notify()
  }

  setState(state: JsonObject): void {
    this.state = state
    this.error = null
    this.loading = false
    this.notify()
  }

  setError(error: Error): void {
    this.error = error
    this.loading = false
    this.notify()
  }

  getState(): JsonObject | null {
    return this.state
  }

  isLoading(): boolean {
    return this.loading
  }

  getError(): Error | null {
    return this.error
  }

  clear(): void {
    this.state = null
    this.loading = false
    this.error = null
    this.notify()
  }
}

export const piSessionStateStore = new PiSessionStateStore()
