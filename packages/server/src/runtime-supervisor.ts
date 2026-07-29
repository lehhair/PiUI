import { getPiWorkerEntryUrl, type WorkerEvent, type WorkerHostCall } from "@piui/pi-worker"
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
  private readonly pendingOpens = new Set<Promise<WorkerSession>>()
  private disposed = false

  constructor(options: RuntimeSupervisorOptions = {}) {
    this.workerEntry = options.workerEntry ?? getPiWorkerEntryUrl()
    this.workerOptions = options.worker
    this.leases = options.leases ?? new SessionLeaseManager()
    this.standbySize = Math.max(1, options.standbySize ?? 2)
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

  async catalogCommand(type: string, params?: JsonObject, options: { retry?: boolean } = {}): Promise<JsonValue | undefined> {
    if (this.disposed) throw new Error("Runtime supervisor is disposed")
    const catalog = this.catalog ?? (this.catalog = this.createCatalog())
    try {
      return await catalog.command(type, params)
    } catch (error) {
      if (this.disposed || this.catalog === catalog) throw error
      if (!options.retry) {
        throw Object.assign(
          new Error("Pi catalog worker crashed before confirming the command result", { cause: error }),
          { code: "WORKER_RESULT_UNKNOWN" },
        )
      }
      const replacement = this.catalog ?? (this.catalog = this.createCatalog())
      return replacement.command(type, params)
    }
  }

  onEvent(listener: (event: WorkerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  open(cwd: string, sessionFile?: string): Promise<WorkerSession> {
    if (this.disposed) return Promise.reject(new Error("Runtime supervisor is disposed"))
    const opening = this.performOpen(cwd, sessionFile)
    this.pendingOpens.add(opening)
    void opening.finally(() => this.pendingOpens.delete(opening)).catch(() => undefined)
    return opening
  }

  private async performOpen(cwd: string, sessionFile?: string): Promise<WorkerSession> {
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
      const runtimeSessionFile = sessionFile ?? runtime.getSessionFile() ?? `memory:${runtime.getSessionId()}`
      if (lease) await lease.refresh(runtimeSessionFile, runtime.getSessionId())
      else lease = await this.leases.acquire(runtimeSessionFile, runtime.getSessionId())
      if (this.disposed) {
        await runtime.dispose()
        lease.release()
        throw new Error("Runtime supervisor is disposed")
      }
      const release = once(() => lease?.release())
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
          const reservation = reservations.get(call.reservationId)
          if (!reservation) throw Object.assign(new Error("Replacement reservation not found"), { code: "INTERNAL" })
          const replacement = call.replacement as { targetSessionFile?: string; targetSessionId?: string }
          await reservation.commit(replacement.targetSessionFile, replacement.targetSessionId)
          reservations.delete(call.reservationId)
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
    const catalog = WorkerSession.createCatalog(this.workerEntry, this.workerOptions)
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

function once(run: () => void): () => void {
  let called = false
  return () => {
    if (called) return
    called = true
    run()
  }
}
