import type { JsonObject } from '@piui/protocol'

/**
 * Raw session runtime state store.
 * Stores state.get result for active session.
 */
class PiSessionStateStore {
  private state: JsonObject | null = null
  private loading = false
  private error: Error | null = null

  setLoading(loading: boolean): void {
    this.loading = loading
  }

  setState(state: JsonObject): void {
    this.state = state
    this.error = null
  }

  setError(error: Error): void {
    this.error = error
    this.loading = false
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
  }
}

export const piSessionStateStore = new PiSessionStateStore()
