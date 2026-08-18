import { getPiWorkerEntryUrl, type WorkerEvent, type WorkerHello, type WorkerHostCall } from "@piui/pi-worker"
import { resolve } from "node:path"
import type { JsonObject, JsonValue } from "@piui/protocol"
import {
  WorkerSession,
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
}

export interface RuntimeLeaseManager {
  acquire(sessionFile: string, sessionId?: string): Promise<SessionLease>
  dispose(): void
}

/**
 * 运行时监督者：所有 pi runtime（catalog 全局命令 + 每个会话的 runtime）
 * 共享**一个** worker 进程。pi SDK 原生支持单进程多 runtime——每会话一个
 * 独立进程会让 ~300MB 的 SDK 基线（bun 打包的完整依赖）线性叠加。
 *
 * 进程崩溃 = 全部会话失效（worker 侧有 uncaughtException 兜底只记录不退出），
 * 由 session-host 逐个清理，前端自愈重新 attach。
 */
export class RuntimeSupervisor {
  private readonly workerEntry: URL
  private readonly workerOptions?: WorkerClientOptions
  private readonly leases: RuntimeLeaseManager
  private runtimeHost?: WorkerHost
  private readonly eventListeners = new Set<(event: WorkerEvent) => void>()
  private readonly active = new Set<WorkerSession>()
  private readonly pendingOpens = new Set<Promise<WorkerSession>>()
  private readonly runtimeLeases = new Map<WorkerSession, SessionLease>()
  private disposed = false

  constructor(options: RuntimeSupervisorOptions = {}) {
    this.workerEntry = options.workerEntry ?? getPiWorkerEntryUrl()
    this.workerOptions = options.worker
    this.leases = options.leases ?? new SessionLeaseManager()
  }

  private ensureRuntimeHost(): WorkerHost {
    if (this.runtimeHost) return this.runtimeHost
    const host = WorkerSession.createHost(this.workerEntry, this.workerOptions)
    host.onCrash(() => {
      // 进程崩溃：丢弃句柄，下次命令/open 重新孵化新进程（会话由
      // session-host 的 onCrash 逐个清理，这里只负责重建基础设施）。
      if (this.runtimeHost === host) this.runtimeHost = undefined
      void host.dispose().catch(() => undefined)
    })
    host.onEvent(event => {
      for (const listener of this.eventListeners) listener(event)
    })
    this.runtimeHost = host
    return host
  }

  async catalogCommand(type: string, params?: JsonObject, options: { retry?: boolean; idempotent?: boolean; signal?: AbortSignal } = {}): Promise<JsonValue | undefined> {
    if (this.disposed) throw new Error("Runtime supervisor is disposed")
    try {
      return await this.ensureRuntimeHost().command(type, params, options.signal)
    } catch (error) {
      const code = errorCode(error)
      if (code !== "WORKER_RESULT_UNKNOWN" && code !== "REQUEST_ABORTED") throw error
      if (this.disposed) throw error
      if (code === "REQUEST_ABORTED" || !options.retry || !options.idempotent) throw error
      // 命令失败（超时/进程崩溃）：崩溃时 runtimeHost 已被 onCrash 丢弃，
      // 重试会自动孵化新进程；进程还活着时（纯超时）重试同一进程。
      return this.ensureRuntimeHost().command(type, params, options.signal)
    }
  }

  onEvent(listener: (event: WorkerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** 共享 worker 进程的握手（真实 SDK 版本、verified、回退标记），供 health 上报。 */
  getCatalogHandshake(): Promise<WorkerHello> {
    if (this.disposed) return Promise.reject(new Error("Runtime supervisor is disposed"))
    return this.ensureRuntimeHost().getHandshake()
  }

  /**
   * 只读快照握手：worker 未孵化时立即返回 undefined（不触发 ~300MB SDK
   * 冷启动），已孵化则在预算内等握手。专供 health 等高频只读探测——
   * 健康检查绝不能阻塞或卡在 worker 启动上，否则会把「活着」的服务
   * 误判为不可达，触发不必要的清场/重启。
   */
  peekCatalogHandshake(timeoutMs = 3_000): Promise<WorkerHello | undefined> {
    const host = this.runtimeHost
    if (!host || this.disposed) return Promise.resolve(undefined)
    return Promise.race([
      host.getHandshake(),
      new Promise<undefined>(resolve => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs)
        timer.unref?.()
      }),
    ]).catch(() => undefined)
  }

  open(cwd: string, sessionFile?: string, signal?: AbortSignal): Promise<WorkerSession> {
    if (this.disposed) return Promise.reject(new Error("Runtime supervisor is disposed"))
    const opening = this.performOpen(cwd, sessionFile, signal)
    this.pendingOpens.add(opening)
    void opening.finally(() => this.pendingOpens.delete(opening)).catch(() => undefined)
    return opening
  }

  private async performOpen(cwd: string, sessionFile?: string, signal?: AbortSignal): Promise<WorkerSession> {
    let lease: SessionLease | undefined = sessionFile ? await this.leases.acquire(sessionFile) : undefined
    if (this.disposed) {
      lease?.release()
      throw new Error("Runtime supervisor is disposed")
    }
    let runtime: WorkerSession
    try {
      runtime = await this.ensureRuntimeHost().open(cwd, sessionFile, signal)
    } catch (error) {
      lease?.release()
      throw error
    }
    try {
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
      return runtime
    } catch (error) {
      try {
        await runtime.dispose()
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
    // 先关整个 worker 进程：worker 的 cleanup 会 dispose 所有 runtime。
    // 不要并发发 session.close——dispose 命令会让调度器 closing，后到的
    // session.close 全被拒成 RUNTIME_CLOSING，纯噪音。
    const pendingOpens = [...this.pendingOpens]
    await Promise.allSettled([
      this.runtimeHost?.dispose() ?? Promise.resolve(),
      ...pendingOpens,
    ])
    // 进程已死，句柄 dispose 只做本地清理（onClose 释放 lease）
    if (this.active.size > 0) {
      await Promise.allSettled([...this.active].map(runtime => runtime.dispose()))
    }
    this.active.clear()
    this.pendingOpens.clear()
    this.runtimeHost = undefined
    this.leases.dispose()
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined
}

function once(run: () => void): () => void {
  let called = false
  return () => {
    if (called) return
    called = true
    run()
  }
}
