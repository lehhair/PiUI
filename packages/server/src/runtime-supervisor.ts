import { getPiWorkerEntryUrl, type PiModelInfo, type PiSessionInfo } from "@piui/pi-worker"
import {
  PiWorkerSession,
  type PiWorkerCatalog,
  type PiWorkerClientOptions,
  type PiWorkerHost,
} from "./pi-worker-client.ts"
import { SessionLeaseManager, type SessionLease } from "./session-lease.ts"

export interface RuntimeSupervisorOptions {
  workerEntry?: URL
  worker?: PiWorkerClientOptions
  leases?: RuntimeLeaseManager
}

export interface RuntimeLeaseManager {
  acquire(sessionFile: string, sessionId?: string): Promise<SessionLease>
  dispose(): void
}

export class RuntimeSupervisor {
  private readonly workerEntry: URL
  private readonly workerOptions?: PiWorkerClientOptions
  private readonly leases: RuntimeLeaseManager
  private catalog?: PiWorkerCatalog
  private standby: PiWorkerHost
  private readonly active = new Set<PiWorkerSession>()
  private readonly opening = new Set<PiWorkerHost>()
  private readonly pendingOpens = new Set<Promise<PiWorkerSession>>()
  private disposed = false

  constructor(options: RuntimeSupervisorOptions = {}) {
    this.workerEntry = options.workerEntry ?? getPiWorkerEntryUrl()
    this.workerOptions = options.worker
    this.leases = options.leases ?? new SessionLeaseManager()
    this.catalog = this.createCatalog()
    this.standby = this.createHost()
  }

  list(cwd: string): Promise<PiSessionInfo[]> {
    return this.runCatalog(catalog => catalog.list(cwd))
  }

  listAll(): Promise<PiSessionInfo[]> {
    return this.runCatalog(catalog => catalog.listAll())
  }

  listModels(): Promise<PiModelInfo[]> {
    return this.runCatalog(catalog => catalog.listModels())
  }

  open(cwd: string, sessionFile?: string): Promise<PiWorkerSession> {
    if (this.disposed) return Promise.reject(new Error("Runtime supervisor is disposed"))
    const opening = this.performOpen(cwd, sessionFile)
    this.pendingOpens.add(opening)
    void opening.finally(() => this.pendingOpens.delete(opening)).catch(() => undefined)
    return opening
  }

  private async performOpen(cwd: string, sessionFile?: string): Promise<PiWorkerSession> {
    let lease: SessionLease | undefined = sessionFile ? await this.leases.acquire(sessionFile) : undefined
    if (this.disposed) {
      lease?.release()
      throw new Error("Runtime supervisor is disposed")
    }
    const host = this.standby
    this.standby = this.createHost()
    this.opening.add(host)
    try {
      const runtime = await host.open(cwd, sessionFile)
      if (this.disposed) {
        await runtime.dispose()
        lease?.release()
        throw new Error("Runtime supervisor is disposed")
      }
      const runtimeSessionFile = sessionFile ?? runtime.getSessionFile() ?? ""
      if (lease) await lease.refresh(runtimeSessionFile, runtime.getSessionId())
      else lease = await this.leases.acquire(runtimeSessionFile, runtime.getSessionId())
      if (this.disposed) {
        await runtime.dispose()
        lease.release()
        throw new Error("Runtime supervisor is disposed")
      }
      const release = once(() => lease?.release())
      runtime.setReplacementHandler(async replacement => {
        if (replacement.cancelled) return
        await lease?.replace(replacement.targetSessionFile, replacement.targetSessionId)
      })
      runtime.onClose(() => {
        this.active.delete(runtime)
        release()
      })
      this.active.add(runtime)
      this.opening.delete(host)
      return runtime
    } catch (error) {
      this.opening.delete(host)
      try {
        await host.dispose()
      } finally {
        lease?.release()
      }
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const pendingOpens = [...this.pendingOpens]
    await Promise.allSettled([
      ...[...this.active].map(runtime => runtime.dispose()),
      ...[...this.opening].map(host => host.dispose()),
      this.catalog?.dispose() ?? Promise.resolve(),
      this.standby.dispose(),
      ...pendingOpens,
    ])
    this.active.clear()
    this.opening.clear()
    this.pendingOpens.clear()
    this.catalog = undefined
    this.leases.dispose()
  }

  private createHost(): PiWorkerHost {
    return PiWorkerSession.createHost(this.workerEntry, this.workerOptions)
  }

  private createCatalog(): PiWorkerCatalog {
    const catalog = PiWorkerSession.createCatalog(this.workerEntry, this.workerOptions)
    catalog.onCrash(() => {
      if (this.catalog === catalog) this.catalog = undefined
      void catalog.dispose()
    })
    return catalog
  }

  private async runCatalog<T>(run: (catalog: PiWorkerCatalog) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("Runtime supervisor is disposed")
    const catalog = this.catalog ?? (this.catalog = this.createCatalog())
    try {
      return await run(catalog)
    } catch (error) {
      if (this.disposed || this.catalog === catalog) throw error
      const replacement = this.catalog ?? (this.catalog = this.createCatalog())
      return run(replacement)
    }
  }
}

function once(run: () => void): () => void {
  let called = false
  return () => {
    if (called) return
    called = true
    run()
  }
}
