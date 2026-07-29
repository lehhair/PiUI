import type { PiBranchPage } from '../domain/index.js'

/**
 * Raw branch page store for active session.
 * Stores the complete branch data as returned from backend.
 */
class PiBranchStore {
  private data: PiBranchPage | null = null
  private loading = false
  private error: Error | null = null

  setLoading(loading: boolean): void {
    this.loading = loading
  }

  setData(data: PiBranchPage): void {
    this.data = data
    this.error = null
  }

  setError(error: Error): void {
    this.error = error
    this.loading = false
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
  }
}

export const piBranchStore = new PiBranchStore()
