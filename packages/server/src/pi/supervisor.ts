import { getPiWorkerEntryUrl, type WorkerEvent, type WorkerHostCall } from "@piui/pi-worker"
import { resolve } from "node:path"
import type { JsonObject, JsonValue } from "@piui/protocol"
import {
  WorkerSession,
  type WorkerCatalog,
  type WorkerClientOptions,
  type WorkerHost,
} from "./worker-client.ts"
import {
  SessionLeaseManager,
  type SessionLease,
  type SessionReplacementReservation,
} from "./session-lease.ts"

export interface RuntimeSupervisorOptions {
  workerEntry?: URL
  worker?: WorkerClientOptions
  leases?: RuntimeLeaseManager
  standbySize?: number
}

export interface RuntimeLeaseManager {
  acquire(sessionFile: string, sessionId?: string): Promise<SessionLease>
  dispose(): void
}

interface WarmRuntimeSlot {
  promise: Promise<WorkerSession>
  claimed: boolean
  timer?: NodeJS.Timeout
}

const DEFAULT_WARM_RUNTIME_TTL_MS = 5 * 60_000

function warmRuntimeTtlMs(): number {
  const configured = Number(process.env.PIUI_WARM_RUNTIME_TTL_MS)
  return Number.isFinite(configured) && configured >= 30_000
    ? configured
    : DEFAULT_WARM_RUNTIME_TTL_MS
}

export class RuntimeSupervisor {
  private readonly workerEntry: URL
  private readonly workerOptions?: WorkerClientOptions
  private readonly leases: RuntimeLeaseManager
  private catalog?: WorkerCatalog
  private readonly eventListeners = new Set<(event: WorkerEvent) => void>()
  private readonly standbyPool: WorkerHost[] = []
  private readonly standbySize: number
  private readonly active = new Set<WorkerSession>()
  private readonly opening = new Set<WorkerHost>()
  private readonly runtimeLeases = new Map<WorkerSession, SessionLease>()
  private readonly warmSlots = new Map<string, WarmRuntimeSlot>()
  private readonly pendingOpens = new Set<Promise<WorkerSession>>()
  private disposed = false

  constructor(options: RuntimeSupervisorOptions = {}) {
    this.workerEntry = options.workerEntry ?? getPiWorkerEntryUrl()
    this.workerOptions = options.worker
    this.leases = options.leases ?? new SessionLeaseManager()
    // A standby worker is expensive: the compiled server starts another copy
    // of itself for every worker. Create session workers on demand instead of
    // keeping two idle Pi runtimes alive from server startup.
    this.standbySize = Math.max(0, options.standbySize ?? 0)
    this.catalog = this.createCatalog()
    this.replenishStandby()
  }

  private replenishStandby(): void {
    if (this.disposed) return
    while (this.standbyPool.length < this.standbySize) {
      const host = this.createHost()
      this.standbyPool.push(host)
      void host.getHandshake().catch(() => {
        const index = this.standbyPool.indexOf(host)
        if (index < 0) return
        this.standbyPool.splice(index, 1)
        void host.dispose()
      })
    }
  }

  private takeStandby(): WorkerHost {
    const host = this.standbyPool.shift() ?? this.createHost()
    this.replenishStandby()
    return host
  }

  async catalogCommand(type: string, params?: JsonObject, options: { retry?: boolean; idempotent?: boolean; signal?: AbortSignal } = {}): Promise<JsonValue | undefined> {
    if (this.disposed) throw new Error("Runtime supervisor is disposed")
    const catalog = this.catalog ?? (this.catalog = this.createCatalog())
    try {
      return await catalog.command(type, params, options.signal)
    } catch (error) {
      const code = errorCode(error)
      if (code !== "WORKER_RESULT_UNKNOWN" && code !== "REQUEST_ABORTED") throw error
      // 失败的 catalog（握手超时、崩溃）立刻丢弃，下次命令重新孵化——
      // 握不上手的 worker ready 已拒，留着只会无限 500
      if (this.catalog === catalog) this.catalog = undefined
      void catalog.dispose().catch(() => undefined)
      if (this.disposed) throw error
      if (code === "REQUEST_ABORTED" || !options.retry || !options.idempotent) throw error
      const replacement = this.catalog ?? (this.catalog = this.createCatalog())
      return replacement.command(type, params)
    }
  }

  onEvent(listener: (event: WorkerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  open(cwd: string, sessionFile?: string, signal?: AbortSignal): Promise<WorkerSession> {
    if (this.disposed) return Promise.reject(new Error("Runtime supervisor is disposed"))
    const opening = this.performOpen(cwd, sessionFile, signal)
    this.pendingOpens.add(opening)
    void opening.finally(() => this.pendingOpens.delete(opening)).catch(() => undefined)
    return opening
  }

  /** Start one already-open, empty Pi runtime for a workspace. */
  prewarm(cwd: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const key = workspaceKey(cwd)
    if (this.warmSlots.has(key)) return Promise.resolve()

    const slot = { claimed: false } as WarmRuntimeSlot
    slot.promise = this.open(cwd).then(runtime => {
      const current = this.warmSlots.get(key)
      if (current !== slot || slot.claimed || this.disposed) {
        void runtime.dispose()
        throw new Error("warm runtime was discarded")
      }
      return runtime
    }).catch(error => {
      if (this.warmSlots.get(key) === slot) this.warmSlots.delete(key)
      throw error
    })
    this.warmSlots.set(key, slot)
    slot.timer = setTimeout(() => {
      if (this.warmSlots.get(key) !== slot || slot.claimed) return
      slot.claimed = true
      this.warmSlots.delete(key)
      void slot.promise.then(runtime => runtime.dispose()).catch(() => undefined)
    }, warmRuntimeTtlMs())
    slot.timer.unref?.()
    void slot.promise.catch(() => undefined)
    return Promise.resolve()
  }

  /** Claim a warm runtime; the caller becomes responsible for its lifecycle. */
  async takeWarmRuntime(cwd: string): Promise<WorkerSession | undefined> {
    const key = workspaceKey(cwd)
    const slot = this.warmSlots.get(key)
    if (!slot) return undefined
    slot.claimed = true
    this.warmSlots.delete(key)
    if (slot.timer) clearTimeout(slot.timer)
    try {
      return await slot.promise
    } catch {
      return undefined
    }
  }

  private async performOpen(cwd: string, sessionFile?: string, signal?: AbortSignal): Promise<WorkerSession> {
    let lease: SessionLease | undefined = sessionFile ? await this.leases.acquire(sessionFile) : undefined
    if (this.disposed) {
      lease?.release()
      throw new Error("Runtime supervisor is disposed")
    }
    const host = this.takeStandby()
    this.opening.add(host)
    try {
      const runtime = await host.open(cwd, sessionFile, signal)
      if (this.disposed) {
        await runtime.dispose()
        lease?.release()
        throw new Error("Runtime supervisor is disposed")
      }
      const runtimeSessionFile = sessionFile ?? runtime.getSessionFile() ?? `memory:${runtime.getSessionId()}`
      if (lease) await lease.refresh(runtimeSessionFile, runtime.getSessionId())
      else lease = await this.leases.acquire(runtimeSessionFile, runtime.getSessionId())
      if (this.disposed) {
        await runtime.dispose()
        lease.release()
        throw new Error("Runtime supervisor is disposed")
      }
      const release = once(() => lease?.release())
      if (lease) this.runtimeLeases.set(runtime, lease)
      const reservations = new Map<string, SessionReplacementReservation>()
      runtime.setHostCallHandler(async (call: WorkerHostCall) => {
        if (call.type === "extensionReplacement.reserve") {
          if (call.sourceSessionId !== runtime.getSessionId()) {
            throw Object.assign(new Error("Extension replacement source no longer owns the runtime"), {
              code: "RUNTIME_REPLACED",
            })
          }
          if (reservations.has(call.reservationId)) return
          if (!lease?.reserveReplacement) {
            throw Object.assign(new Error("Runtime lease manager cannot reserve replacements"), {
              code: "CAPABILITY_DISABLED",
            })
          }
          reservations.set(
            call.reservationId,
            await lease.reserveReplacement(call.targetSessionFile),
          )
          return
        }
        if (call.type === "extensionReplacement.commit") {
          if (call.replacement.sourceSessionId !== runtime.getSessionId()) {
            throw Object.assign(new Error("Extension replacement source no longer owns the runtime"), {
              code: "RUNTIME_REPLACED",
            })
          }
          const reservation = reservations.get(call.reservationId)
          if (!reservation) throw Object.assign(new Error("Replacement reservation not found"), { code: "INTERNAL" })
          const replacement = call.replacement as { targetSessionFile?: string | null; targetSessionId?: string }
          try {
            await reservation.commit(replacement.targetSessionFile, replacement.targetSessionId)
            reservations.delete(call.reservationId)
          } catch (error) {
            reservation.rollback()
            reservations.delete(call.reservationId)
            setImmediate(() => { void runtime.dispose() })
            throw error
          }
          return
        }
        if (call.type === "extensionReplacement.abort") {
          reservations.get(call.reservationId)?.rollback()
          reservations.delete(call.reservationId)
          return
        }
        if (call.type === "extensionShutdown") {
          if (call.sessionId !== runtime.getSessionId()) return
          setImmediate(() => { void runtime.dispose() })
        }
      })
      runtime.onClose(() => {
        this.active.delete(runtime)
        this.runtimeLeases.delete(runtime)
        for (const reservation of reservations.values()) reservation.rollback()
        reservations.clear()
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

  /**
   * Swap a runtime's lease to the session it switched to (fork/clone/
   * newSession/switchSession/importSession). Without this the source
   * session's lease ports stay held forever and the source can never be
   * attached again (SESSION_BUSY).
   */
  async replaceRuntimeLease(runtime: WorkerSession, sessionFile?: string | null, sessionId?: string): Promise<void> {
    const lease = this.runtimeLeases.get(runtime)
    if (!lease) return
    await lease.replace(sessionFile, sessionId)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const pendingOpens = [...this.pendingOpens]
    const warmPromises = [...this.warmSlots.values()].map(slot => {
      slot.claimed = true
      if (slot.timer) clearTimeout(slot.timer)
      return slot.promise
    })
    this.warmSlots.clear()
    const standby = this.standbyPool.splice(0, this.standbyPool.length)
    await Promise.allSettled([
      ...[...this.active].map(runtime => runtime.dispose()),
      ...[...this.opening].map(host => host.dispose()),
      this.catalog?.dispose() ?? Promise.resolve(),
      ...standby.map(host => host.dispose()),
      ...pendingOpens,
      ...warmPromises,
    ])
    if (this.active.size > 0) {
      await Promise.allSettled([...this.active].map(runtime => runtime.dispose()))
    }
    this.active.clear()
    this.opening.clear()
    this.pendingOpens.clear()
    this.catalog = undefined
    this.leases.dispose()
  }

  private createHost(): WorkerHost {
    return WorkerSession.createHost(this.workerEntry, this.workerOptions)
  }

  private createCatalog(): WorkerCatalog {
    const configuredTimeout = Number(process.env.PIUI_CATALOG_REQUEST_TIMEOUT_MS)
    const requestTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 5_000
      ? configuredTimeout
      : 30_000
    const catalog = WorkerSession.createCatalog(this.workerEntry, {
      ...this.workerOptions,
      requestTimeoutMs,
    })
    catalog.onCrash(() => {
      if (this.catalog === catalog) this.catalog = undefined
      void catalog.dispose()
    })
    catalog.onEvent(event => {
      for (const listener of this.eventListeners) listener(event)
    })
    return catalog
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined
}

function workspaceKey(cwd: string): string {
  const normalized = resolve(cwd).replace(/\\/g, "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function once(run: () => void): () => void {
  let called = false
  return () => {
    if (called) return
    called = true
    run()
  }
}
