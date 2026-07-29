import type { PiBranchPage } from '../domain/index.js'

/**
 * Raw branch page store for active session.
 * Stores the complete branch data as returned from backend.
 * Follows app store convention: subscribe/notify + stable snapshots.
 */
class PiBranchStore {
  private data: PiBranchPage | null = null
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

  setData(data: PiBranchPage): void {
    this.data = data
    this.error = null
    this.loading = false
    this.notify()
  }

  setError(error: Error): void {
    this.error = error
    this.loading = false
    this.notify()
  }

  getData(): PiBranchPage | null {
    return this.data
  }

  isLoading(): boolean {
    return this.loading
  }

  getError(): Error | null {
    return this.error
  }

  clear(): void {
    this.data = null
    this.loading = false
    this.error = null
    this.notify()
  }
}

export const piBranchStore = new PiBranchStore()
