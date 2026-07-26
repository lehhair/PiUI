import { getPiWorkerEntryUrl, type PiModelInfo, type PiSessionInfo } from "@piui/pi-worker"
import type {
  PiSettingsPatchV1,
  PiSettingsSnapshotV1,
  ProjectTrustV1,
  ProviderAuthEventV1,
  ProviderAuthInfoV1,
  ConfiguredPackageV1,
  PackageProgressV1,
  ResolvedPackageResourcesV1,
  PackageUpdateV1,
  PiModelRuntimeSnapshotV1,
} from "@piui/protocol"
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
  /**
   * How many pre-warmed workers to keep. Booting one costs ~1.7s, so opening a
   * session is only fast while a warm worker is available; a single spare made
   * every burst of openings after the first pay that cost.
   */
  standbySize?: number
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
  private readonly providerAuthListeners = new Set<(event: ProviderAuthEventV1) => void>()
  private readonly packageProgressListeners = new Set<(event: PackageProgressV1) => void>()
  private readonly standbyPool: PiWorkerHost[] = []
  private readonly standbySize: number
  private readonly active = new Set<PiWorkerSession>()
  private readonly opening = new Set<PiWorkerHost>()
  private readonly pendingOpens = new Set<Promise<PiWorkerSession>>()
  private disposed = false

  constructor(options: RuntimeSupervisorOptions = {}) {
    this.workerEntry = options.workerEntry ?? getPiWorkerEntryUrl()
    this.workerOptions = options.worker
    this.leases = options.leases ?? new SessionLeaseManager()
    this.standbySize = Math.max(1, options.standbySize ?? 2)
    this.catalog = this.createCatalog()
    this.replenishStandby()
  }

  /** Never refills after disposal, otherwise shutdown would leak workers. */
  private replenishStandby(): void {
    if (this.disposed) return
    while (this.standbyPool.length < this.standbySize) {
      this.standbyPool.push(this.createHost())
    }
  }

  private takeStandby(): PiWorkerHost {
    const host = this.standbyPool.shift() ?? this.createHost()
    this.replenishStandby()
    return host
  }

  list(cwd: string): Promise<PiSessionInfo[]> {
    return this.runCatalog(catalog => catalog.list(cwd), { retry: true })
  }

  listAll(): Promise<PiSessionInfo[]> {
    return this.runCatalog(catalog => catalog.listAll(), { retry: true })
  }

  listModels(): Promise<PiModelInfo[]> {
    return this.runCatalog(catalog => catalog.listModels(), { retry: true })
  }

  getSettings(cwd: string): Promise<PiSettingsSnapshotV1> {
    return this.runCatalog(catalog => catalog.getSettings(cwd), { retry: true })
  }

  patchSettings(cwd: string, patch: PiSettingsPatchV1): Promise<PiSettingsSnapshotV1> {
    return this.runCatalog(catalog => catalog.patchSettings(cwd, patch))
  }

  getProjectTrust(cwd: string): Promise<ProjectTrustV1> {
    return this.runCatalog(catalog => catalog.getProjectTrust(cwd), { retry: true })
  }

  setProjectTrust(cwd: string, decision: boolean | null): Promise<ProjectTrustV1> {
    return this.runCatalog(catalog => catalog.setProjectTrust(cwd, decision))
  }

  listProviders(): Promise<ProviderAuthInfoV1[]> {
    return this.runCatalog(catalog => catalog.listProviders(), { retry: true })
  }

  startProviderAuth(providerId: string, authType: "api_key" | "oauth"): Promise<string> {
    return this.runCatalog(catalog => catalog.startProviderAuth(providerId, authType))
  }

  respondProviderAuth(flowId: string, promptId: string, value: string): Promise<void> {
    return this.runCatalog(catalog => catalog.respondProviderAuth(flowId, promptId, value))
  }

  cancelProviderAuth(flowId: string): Promise<void> {
    return this.runCatalog(catalog => catalog.cancelProviderAuth(flowId))
  }

  logoutProvider(providerId: string): Promise<void> {
    return this.runCatalog(catalog => catalog.logoutProvider(providerId))
  }

  inspectModelRuntime(): Promise<PiModelRuntimeSnapshotV1> {
    return this.runCatalog(catalog => catalog.inspectModelRuntime(), { retry: true })
  }

  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
    return this.runCatalog(catalog => catalog.setRuntimeApiKey(providerId, apiKey))
  }

  removeRuntimeApiKey(providerId: string): Promise<void> {
    return this.runCatalog(catalog => catalog.removeRuntimeApiKey(providerId))
  }

  reloadModelRuntime(): Promise<void> {
    return this.runCatalog(catalog => catalog.reloadModelRuntime())
  }

  refreshModelRuntime(options?: Record<string, unknown>): Promise<unknown> {
    return this.runCatalog(catalog => catalog.refreshModelRuntime(options))
  }

  onProviderAuth(listener: (event: ProviderAuthEventV1) => void): () => void {
    this.providerAuthListeners.add(listener)
    return () => this.providerAuthListeners.delete(listener)
  }

  listPackages(cwd: string): Promise<ConfiguredPackageV1[]> {
    return this.runCatalog(catalog => catalog.listPackages(cwd), { retry: true })
  }

  managePackage(
    cwd: string,
    commandId: string,
    action: "install" | "remove" | "update",
    source?: string,
    local?: boolean,
    persist?: boolean,
  ): Promise<ConfiguredPackageV1[]> {
    return this.runCatalog(catalog => catalog.managePackage(cwd, commandId, action, source, local, persist))
  }

  resolvePackages(cwd: string, missingAction?: "skip" | "error"): Promise<ResolvedPackageResourcesV1> {
    return this.runCatalog(catalog => catalog.resolvePackages(cwd, missingAction))
  }

  resolveExtensionSources(
    cwd: string,
    sources: string[],
    options?: { local?: boolean; temporary?: boolean },
  ): Promise<ResolvedPackageResourcesV1> {
    return this.runCatalog(catalog => catalog.resolveExtensionSources(cwd, sources, options))
  }

  changePackageSource(
    cwd: string,
    source: string,
    operation: "add" | "remove",
    local?: boolean,
  ): Promise<{ changed: boolean; packages: ConfiguredPackageV1[] }> {
    return this.runCatalog(catalog => catalog.changePackageSource(cwd, source, operation, local))
  }

  getInstalledPackagePath(cwd: string, source: string, scope: "user" | "project"): Promise<string | undefined> {
    return this.runCatalog(catalog => catalog.getInstalledPackagePath(cwd, source, scope), { retry: true })
  }

  checkPackageUpdates(cwd: string): Promise<PackageUpdateV1[]> {
    return this.runCatalog(catalog => catalog.checkPackageUpdates(cwd), { retry: true })
  }

  onPackageProgress(listener: (event: PackageProgressV1) => void): () => void {
    this.packageProgressListeners.add(listener)
    return () => this.packageProgressListeners.delete(listener)
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
    const host = this.takeStandby()
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
    const standby = this.standbyPool.splice(0, this.standbyPool.length)
    await Promise.allSettled([
      ...[...this.active].map(runtime => runtime.dispose()),
      ...[...this.opening].map(host => host.dispose()),
      this.catalog?.dispose() ?? Promise.resolve(),
      ...standby.map(host => host.dispose()),
      ...pendingOpens,
    ])
    // An open that resolved after the sweep above registers itself in `active`,
    // so clean up anything that appeared while we were waiting.
    if (this.active.size > 0) {
      await Promise.allSettled([...this.active].map(runtime => runtime.dispose()))
    }
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
    catalog.onProviderAuth(event => {
      for (const listener of this.providerAuthListeners) listener(event)
    })
    catalog.onPackageProgress(event => {
      for (const listener of this.packageProgressListeners) listener(event)
    })
    return catalog
  }

  private async runCatalog<T>(
    run: (catalog: PiWorkerCatalog) => Promise<T>,
    options: { retry?: boolean } = {},
  ): Promise<T> {
    if (this.disposed) throw new Error("Runtime supervisor is disposed")
    const catalog = this.catalog ?? (this.catalog = this.createCatalog())
    try {
      return await run(catalog)
    } catch (error) {
      if (this.disposed || this.catalog === catalog) throw error
      if (!options.retry) {
        throw Object.assign(
          new Error("Pi catalog worker crashed before confirming the command result", { cause: error }),
          { code: "WORKER_RESULT_UNKNOWN" },
        )
      }
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
