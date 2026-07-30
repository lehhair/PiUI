import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { JsonObject, JsonValue, Problem } from "@piui/protocol"
import {
  PI_WORKER_HEARTBEAT_INTERVAL_MS,
  PI_WORKER_PROTOCOL_VERSION,
  type WorkerEvent,
  type WorkerHello,
  type WorkerHostCall,
  type WorkerMessage,
} from "@piui/pi-worker"

export interface WorkerClientOptions {
  env?: NodeJS.ProcessEnv
  execArgv?: string[]
  requestTimeoutMs?: number
  handshakeTimeoutMs?: number
}

interface PendingRequest {
  resolve: (data: JsonValue | undefined) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface WorkerCatalog {
  command(type: string, params?: JsonObject): Promise<JsonValue | undefined>
  onEvent(listener: (event: WorkerEvent) => void): () => void
  onCrash(listener: (error: Error) => void): () => void
  dispose(): Promise<void>
}

export interface WorkerHost {
  getHandshake(): Promise<WorkerHello>
  open(cwd: string, sessionFile?: string): Promise<WorkerSession>
  dispose(): Promise<void>
}

const HEARTBEAT_MISS_LIMIT = 3

export class WorkerSession {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: WorkerEvent) => void>()
  private readonly crashListeners = new Set<(error: Error) => void>()
  private readonly closeListeners = new Set<() => void>()
  private hostCallHandler?: (call: WorkerHostCall) => void | Promise<void>
  private child: ChildProcess
  private sessionId?: string
  private sessionFile?: string
  private cwd?: string
  private disposed = false
  private exitHandled = false
  private closeNotified = false
  private heartbeatTimer?: NodeJS.Timeout
  private heartbeatMisses = 0
  private exitError?: Error
  private readonly ready: Promise<WorkerHello>
  private resolveReady!: (hello: WorkerHello) => void
  private rejectReady!: (error: Error) => void
  private readySettled = false

  private constructor(
    private readonly workerEntry: URL,
    private readonly options: WorkerClientOptions = {},
  ) {
    this.ready = new Promise<WorkerHello>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.child = this.spawn()
  }

  static createHost(workerEntry: URL, options?: WorkerClientOptions): WorkerHost {
    const session = new WorkerSession(workerEntry, options)
    return {
      getHandshake: () => session.ready,
      open: (cwd, sessionFile) => session.openRuntime(cwd, sessionFile),
      dispose: () => session.dispose(),
    }
  }

  static createCatalog(workerEntry: URL, options?: WorkerClientOptions): WorkerCatalog {
    const session = new WorkerSession(workerEntry, options)
    return {
      command: (type, params) => session.request({ type, params }),
      onEvent: listener => session.onEvent(listener),
      onCrash: listener => session.onCrash(listener),
      dispose: () => session.dispose(),
    }
  }

  private spawn(): ChildProcess {
    const child = fork(this.workerEntry, {
      env: { ...process.env, ...this.options.env },
      execArgv: this.options.execArgv,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    })
    const handshakeTimeout = setTimeout(() => {
      this.settleReadyError(Object.assign(new Error("Pi worker handshake timed out"), { code: "WORKER_PROTOCOL_MISMATCH" }))
    }, this.options.handshakeTimeoutMs ?? 15_000)
    handshakeTimeout.unref()
    this.ready.finally(() => clearTimeout(handshakeTimeout)).catch(() => undefined)

    child.on("message", (message: WorkerMessage) => this.handleMessage(message))
    child.on("exit", (code, signal) => this.handleExit(code, signal))
    child.on("error", error => this.handleExit(1, null, error))
    return child
  }

  private handleMessage(message: WorkerMessage): void {
    if (!message || typeof message !== "object") return
    if (message.kind === "hello") {
      if (message.workerProtocolVersion !== PI_WORKER_PROTOCOL_VERSION) {
        this.settleReadyError(Object.assign(
          new Error(`Pi worker protocol ${message.workerProtocolVersion} does not match ${PI_WORKER_PROTOCOL_VERSION}`),
          { code: "WORKER_PROTOCOL_MISMATCH" },
        ))
        return
      }
      this.heartbeatMisses = 0
      this.startHeartbeatWatchdog()
      if (!this.readySettled) {
        this.readySettled = true
        this.resolveReady(message)
      }
      return
    }
    if (message.kind === "heartbeat") {
      this.heartbeatMisses = 0
      return
    }
    if (message.kind === "response") {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.data)
      else pending.reject(problemToError(message.error))
      return
    }
    if (message.kind === "event") {
      for (const listener of this.eventListeners) {
        try {
          listener(message)
        } catch {
          /* one failed listener must not break the others */
        }
      }
      return
    }
    if (message.kind === "hostCall") {
      void this.answerHostCall(message.id, message.generation, message.call)
      return
    }
  }

  private async answerHostCall(id: string, generation: string, call: WorkerHostCall): Promise<void> {
    if (!this.hostCallHandler) {
      this.child.send({ kind: "hostReply", id, generation, ok: false, error: { code: "CAPABILITY_DISABLED", message: "no host call handler" } })
      return
    }
    try {
      await this.hostCallHandler(call)
      this.child.send({ kind: "hostReply", id, generation, ok: true })
    } catch (error) {
      this.child.send({
        kind: "hostReply",
        id,
        generation,
        ok: false,
        error: {
          code: error && typeof error === "object" && "code" in error ? String(error.code) : "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private startHeartbeatWatchdog(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatMisses += 1
      if (this.heartbeatMisses > HEARTBEAT_MISS_LIMIT) {
        this.handleExit(null, null, Object.assign(new Error("Pi worker heartbeat timed out"), {
          code: "SESSION_RUNTIME_CRASHED",
        }))
        this.child.kill("SIGKILL")
      }
    }, PI_WORKER_HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.exitHandled) return
    this.exitHandled = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.exitError = error ?? (this.disposed
      ? Object.assign(new Error("Pi worker disposed"), { code: "SESSION_RUNTIME_CRASHED" })
      : Object.assign(new Error(`Pi worker exited unexpectedly (code ${code} signal ${signal})`), {
        code: "SESSION_RUNTIME_CRASHED",
      }))
    this.settleReadyError(this.exitError)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(Object.assign(new Error("Pi worker crashed before confirming the command result"), {
        code: "WORKER_RESULT_UNKNOWN",
      }))
    }
    this.pending.clear()
    if (!this.disposed) {
      for (const listener of this.crashListeners) {
        try {
          listener(this.exitError)
        } catch {
          /* ignore */
        }
      }
    }
    this.notifyClose()
  }

  private settleReadyError(error: Error): void {
    if (this.readySettled) return
    this.readySettled = true
    this.rejectReady(error)
  }

  private notifyClose(): void {
    if (this.closeNotified) return
    this.closeNotified = true
    for (const listener of this.closeListeners) {
      try {
        listener()
      } catch {
        /* ignore */
      }
    }
  }

  private async openRuntime(cwd: string, sessionFile?: string): Promise<WorkerSession> {
    await this.ready
    const data = await this.request({
      type: "session.open",
      params: { cwd, sessionFile: sessionFile ?? null },
    })
    const opened = data as { sessionId?: string; sessionFile?: string; cwd?: string } | undefined
    this.sessionId = opened?.sessionId
    this.sessionFile = opened?.sessionFile ?? sessionFile
    this.cwd = opened?.cwd ?? cwd
    return this
  }

  getSessionId(): string {
    return this.sessionId ?? ""
  }

  /** After a runtime replacement (fork/clone/new/import), the worker owns a
   * different session — requests must carry the new id or the worker
   * rejects them as RUNTIME_REPLACED. */
  updateSessionIdentity(sessionId: string, sessionFile?: string, cwd?: string): void {
    this.sessionId = sessionId
    if (sessionFile !== undefined) this.sessionFile = sessionFile
    if (cwd !== undefined) this.cwd = cwd
  }

  getSessionFile(): string | undefined {
    return this.sessionFile
  }

  getCwd(): string {
    return this.cwd ?? ""
  }

  async command(type: string, params?: JsonObject): Promise<JsonValue | undefined> {
    return this.request({ type, params })
  }

  private request(command: { type: string; params?: JsonObject }): Promise<JsonValue | undefined> {
    if (this.exitHandled) return Promise.reject(this.exitError ?? new Error("Pi worker is not available"))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`Pi worker command timed out: ${command.type}`), {
          code: "WORKER_RESULT_UNKNOWN",
        }))
      }, this.options.requestTimeoutMs ?? 10 * 60_000)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      void this.ready.then(helloMessage => {
        if (this.exitHandled) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(this.exitError ?? new Error("Pi worker is not available"))
          return
        }
        this.child.send({
          kind: "request",
          id,
          generation: helloMessage.generation,
          sessionId: this.sessionId,
          command,
        }, error => {
          if (!error) return
          this.pending.delete(id)
          clearTimeout(timer)
          reject(error)
        })
      }).catch(error => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  onEvent(listener: (event: WorkerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onCrash(listener: (error: Error) => void): () => void {
    this.crashListeners.add(listener)
    return () => this.crashListeners.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  setHostCallHandler(handler: (call: WorkerHostCall) => void | Promise<void>): void {
    this.hostCallHandler = handler
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.exitHandled) return
    try {
      await Promise.race([
        new Promise<void>(resolve => {
          const hello = this.ready
          void hello.then(helloMessage => {
            this.child.send({ kind: "request", id: randomUUID(), generation: helloMessage.generation, command: { type: "dispose" } }, () => resolve())
          }).catch(() => resolve())
        }),
        new Promise<void>(resolve => setTimeout(resolve, 5_000)),
      ])
    } finally {
      if (!this.exitHandled) {
        this.child.kill("SIGKILL")
        this.handleExit(null, "SIGKILL")
      }
    }
  }
}

function problemToError(problem: Problem): Error {
  return Object.assign(new Error(problem.message), { code: problem.code, details: problem.details })
}
