import { fork, spawn, type ChildProcess } from "node:child_process"
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
  /**
   * 是否以 self-spawn 方式孵化 worker（bun 单文件 exe）。由 bundle-entry
   * 显式传入；不再读 PIUI_WORKER_SELF 环境变量——那个变量会顺着子进程
   * 树泄漏到业务命令，污染 node 开发模式。
   */
  selfSpawn?: boolean
}

interface PendingRequest {
  resolve: (data: JsonValue | undefined) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  removeAbort?: () => void
}

/**
 * Spawning the SDK worker takes seconds on a loaded machine (cold boot even
 * more); tests that spawn several workers in parallel can widen the budget
 * via env.
 */
function defaultHandshakeTimeoutMs(): number {
  const fromEnv = Number(process.env.PIUI_WORKER_HANDSHAKE_TIMEOUT_MS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30_000
}

export interface WorkerCatalog {
  command(type: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonValue | undefined>
  getHandshake(): Promise<WorkerHello>
  onEvent(listener: (event: WorkerEvent) => void): () => void
  onCrash(listener: (error: Error) => void): () => void
  dispose(): Promise<void>
}

/**
 * 共享 runtime 进程句柄。一个进程承载所有会话 runtime + 全局 catalog
 * 命令——pi SDK 原生支持单进程多 runtime（共享 ModelRuntime），每个会话
 * 一个独立进程会让每进程 ~300MB 的 SDK 基线线性叠加。
 */
export interface WorkerHost {
  getHandshake(): Promise<WorkerHello>
  /** 在共享进程内打开一个会话 runtime，返回每会话句柄 */
  open(cwd: string, sessionFile?: string, signal?: AbortSignal): Promise<WorkerSession>
  /** 无会话归属的全局事件（provider.auth / packages.progress / resources.updated） */
  onEvent(listener: (event: WorkerEvent) => void): () => void
  onCrash(listener: (error: Error) => void): () => void
  /** 全局命令（catalog 语义：registry.describe / session.listAll / packages.* 等） */
  command(type: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonValue | undefined>
  /** 销毁整个共享进程（关掉所有 runtime） */
  dispose(): Promise<void>
}

/**
 * 心跳只用于兜底发现「真死」的 worker（事件循环永久卡死/通道悬挂）。
 * 事件循环繁忙不是死——大会话 JSONL 加载、大对象序列化、GC 都会让心跳
 * 延迟，误杀繁忙但健康的共享进程会让所有会话一起崩（对齐 opencode 的
 * 思路：进程死活信 exit/disconnect 事件，看门狗只是最后一道兜底，预算
 * 要给足）。默认 12 次 × 5s ≈ 65s 才判定死亡，可用 env 调整。
 */
function heartbeatMissLimit(): number {
  const fromEnv = Number(process.env.PIUI_WORKER_HEARTBEAT_MISS_LIMIT)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 12
}

/**
 * 终止 worker 及其整棵子进程树。Windows 上 signal 只终止进程本身且不级联
 * ——worker 拉起的 provider/MCP 子进程会变孤儿继续占着端口/文件，所以用
 * taskkill /T /F（对齐 opencode util/process.ts 的做法）。
 */
function killProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
        .on("error", () => undefined)
      return
    } catch {
      /* fall through to plain kill */
    }
  }
  try {
    child.kill("SIGKILL")
  } catch {
    /* already gone */
  }
}

/**
 * 主动关闭 worker 的预算：worker 要 abort 在途流、flush JSONL、dispose 所有
 * runtime，负载机器上 5s 经常不够——预算内等不到再升级 SIGKILL，避免每次
 * 优雅关闭都以强杀收场（可能写坏 session 文件）。
 */
function disposeTimeoutMs(): number {
  const fromEnv = Number(process.env.PIUI_WORKER_DISPOSE_TIMEOUT_MS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 15_000
}

/**
 * 单条命令的超时预算。默认 60s：worker 卡死（进程活着但事件循环不动）时
 * 前端请求不该挂 10 分钟——SDK 内部一次正常调用极少超过 60s，超时即视为
 * 该命令失败；若心跳同时丢失，说明进程级卡死，直接杀掉重建（见 request）。
 */
function requestTimeoutMs(): number {
  const fromEnv = Number(process.env.PIUI_WORKER_REQUEST_TIMEOUT_MS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 60_000
}

/**
 * 一个 worker 进程的客户端核心：持有进程、pending 请求、心跳看门狗，
 * 并把事件/hostCall 按 sessionId 路由到对应的 WorkerSession 句柄。
 */
class WorkerHostCore {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly hostEventListeners = new Set<(event: WorkerEvent) => void>()
  private readonly crashListeners = new Set<(error: Error) => void>()
  /** sessionId → 句柄（runtime 替换后 key 随 updateSessionIdentity 迁移） */
  private readonly handles = new Map<string, WorkerSession>()
  private readonly hostCallHandlers = new Map<string, (call: WorkerHostCall) => void | Promise<void>>()
  /** reservationId → sessionId：commit/abort 没有会话字段，靠 reserve 时的归属路由 */
  private readonly reservationOwners = new Map<string, string>()
  private child: ChildProcess
  private disposed = false
  private exitHandled = false
  private heartbeatTimer?: NodeJS.Timeout
  private heartbeatMisses = 0
  private exitError?: Error
  private readonly ready: Promise<WorkerHello>
  private readonly exited: Promise<void>
  private resolveReady!: (hello: WorkerHello) => void
  private rejectReady!: (error: Error) => void
  private resolveExited!: () => void
  private readySettled = false

  constructor(
    private readonly workerEntry: URL,
    private readonly options: WorkerClientOptions = {},
  ) {
    this.ready = new Promise<WorkerHello>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.exited = new Promise<void>(resolve => {
      this.resolveExited = resolve
    })
    this.child = this.spawn()
  }

  private spawn(): ChildProcess {
    // 编译成单文件 exe 时没有独立 node 可 fork——worker 就是同一个 exe
    // 加 --pi-worker 参数再拉一个自己，IPC 通道不变。self-spawn 意图由
    // options.selfSpawn 显式传入（bundle-entry 只在 bun 下置 true），不
    // 再依赖 PIUI_WORKER_SELF 环境变量——它从 bun server 顺着子进程链
    // 泄漏到 node 开发模式时，self-spawn 会变成 node.exe --pi-worker
    // （bad option），worker 永远起不来。
    const child = this.options.selfSpawn
      ? spawnSelfWorker(this.options.env)
      : fork(this.workerEntry, {
        env: { ...process.env, ...this.options.env },
        execArgv: this.options.execArgv,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      })
    const handshakeTimeout = setTimeout(() => {
      this.settleReadyError(Object.assign(new Error("Pi worker handshake timed out"), { code: "WORKER_PROTOCOL_MISMATCH" }))
      // 握不上手就杀掉——否则僵尸进程占着端口，而它的 ready 已拒，
      // 再也不可用
      killProcessTree(this.child)
    }, this.options.handshakeTimeoutMs ?? defaultHandshakeTimeoutMs())
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
      this.startHeartbeatWatchdog(message.heartbeatIntervalMs || PI_WORKER_HEARTBEAT_INTERVAL_MS)
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
      pending.removeAbort?.()
      if (message.ok) pending.resolve(message.data)
      else pending.reject(problemToError(message.error))
      return
    }
    if (message.kind === "event") {
      // 带 sessionId 的事件路由到对应句柄；无归属的全局事件广播给 host 监听者
      if ("sessionId" in message && message.sessionId) {
        this.handles.get(message.sessionId)?.dispatchEvent(message)
      } else {
        for (const listener of this.hostEventListeners) {
          try {
            listener(message)
          } catch {
            /* one failed listener must not break the others */
          }
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
    let sessionId: string | undefined
    if ("sourceSessionId" in call) {
      sessionId = call.sourceSessionId
    } else if (call.type === "extensionShutdown") {
      sessionId = call.sessionId
    } else {
      sessionId = this.reservationOwners.get(call.reservationId)
    }
    const handler = sessionId ? this.hostCallHandlers.get(sessionId) : undefined
    if (!handler) {
      this.child.send({ kind: "hostReply", id, generation, ok: false, error: { code: "CAPABILITY_DISABLED", message: "no host call handler" } })
      return
    }
    try {
      await handler(call)
      if (call.type === "extensionReplacement.reserve") {
        this.reservationOwners.set(call.reservationId, call.sourceSessionId)
      }
      if (call.type === "extensionReplacement.commit" && call.replacement.cancelled === false) {
        const handle = this.handles.get(sessionId!)
        if (handle) await handle.dispatchReplacement(call.replacement)
        this.reservationOwners.delete(call.reservationId)
      }
      if (call.type === "extensionReplacement.abort") {
        this.reservationOwners.delete(call.reservationId)
      }
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

  private startHeartbeatWatchdog(intervalMs: number): void {
    if (this.heartbeatTimer) return
    const missLimit = heartbeatMissLimit()
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatMisses += 1
      if (this.heartbeatMisses > missLimit) {
        // 先杀后记账：反过来会有「server 已判死并孵化新 worker，旧进程还
        // 活着」的并存窗口
        killProcessTree(this.child)
        this.handleExit(null, null, Object.assign(new Error("Pi worker heartbeat timed out"), {
          code: "SESSION_RUNTIME_CRASHED",
        }))
      }
    }, intervalMs)
    this.heartbeatTimer.unref()
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.exitHandled) return
    this.exitHandled = true
    this.resolveExited()
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.exitError = error ?? (this.disposed
      ? Object.assign(new Error("Pi worker disposed"), { code: "SESSION_RUNTIME_CRASHED" })
      : Object.assign(new Error(`Pi worker exited unexpectedly (code ${code} signal ${signal})`), {
        code: "SESSION_RUNTIME_CRASHED",
      }))
    // 崩溃/退出必须有可见记录：之前这里完全静默，用户（和日志）无法知道
    // worker 何时、为何死亡，"突然死了"无从排查。
    if (!this.disposed) {
      console.error(`[piui-worker] worker process exited unexpectedly (pid=${this.child.pid ?? "?"} code=${code} signal=${signal}): ${this.exitError.message}`)
    } else {
      console.info(`[piui-worker] worker process stopped (pid=${this.child.pid ?? "?"})`)
    }
    this.settleReadyError(this.exitError)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.removeAbort?.()
      pending.reject(Object.assign(new Error("Pi worker crashed before confirming the command result"), {
        code: "WORKER_RESULT_UNKNOWN",
      }))
    }
    this.pending.clear()
    // 共享进程崩溃 = 所有会话 runtime 一起失效：逐个句柄通知
    const handles = [...this.handles.values()]
    this.handles.clear()
    this.hostCallHandlers.clear()
    if (!this.disposed) {
      for (const listener of this.crashListeners) {
        try {
          listener(this.exitError)
        } catch {
          /* ignore */
        }
      }
    }
    for (const handle of handles) handle.dispatchCrash(this.exitError)
  }

  private settleReadyError(error: Error): void {
    if (this.readySettled) return
    this.readySettled = true
    this.rejectReady(error)
  }

  getHandshake(): Promise<WorkerHello> {
    return this.ready
  }

  async open(cwd: string, sessionFile?: string, signal?: AbortSignal): Promise<WorkerSession> {
    await this.ready
    const data = await this.request({
      type: "session.open",
      params: { cwd, sessionFile: sessionFile ?? null },
    }, signal)
    const opened = data as { sessionId?: string; sessionFile?: string; cwd?: string } | undefined
    const sessionId = opened?.sessionId
    if (!sessionId) {
      throw Object.assign(new Error("Pi worker session.open returned no session id"), { code: "WORKER_RESULT_UNKNOWN" })
    }
    const handle = new WorkerSession(this, {
      sessionId,
      sessionFile: opened?.sessionFile ?? sessionFile,
      cwd: opened?.cwd ?? cwd,
    })
    this.handles.set(handle.getSessionId(), handle)
    return handle
  }

  /** 迁移句柄在路由表里的 key（runtime 替换后 sessionId 变化时由句柄调用） */
  rebindHandle(handle: WorkerSession, previousSessionId: string, nextSessionId: string): void {
    if (this.handles.get(previousSessionId) === handle) {
      this.handles.delete(previousSessionId)
      this.handles.set(nextSessionId, handle)
    }
    const hostCallHandler = this.hostCallHandlers.get(previousSessionId)
    if (hostCallHandler) {
      this.hostCallHandlers.delete(previousSessionId)
      this.hostCallHandlers.set(nextSessionId, hostCallHandler)
    }
  }

  setHostCallHandler(sessionId: string, handler: (call: WorkerHostCall) => void | Promise<void>): void {
    this.hostCallHandlers.set(sessionId, handler)
  }

  /** 句柄关闭后从路由表注销（session.close 或句柄主动销毁） */
  unregisterHandle(handle: WorkerSession, sessionId: string): void {
    if (this.handles.get(sessionId) === handle) this.handles.delete(sessionId)
    this.hostCallHandlers.delete(sessionId)
  }

  /** 进程已退出/被销毁（句柄 dispose 时不再发命令） */
  isGone(): boolean {
    return this.exitHandled
  }

  onEvent(listener: (event: WorkerEvent) => void): () => void {
    this.hostEventListeners.add(listener)
    return () => this.hostEventListeners.delete(listener)
  }

  onCrash(listener: (error: Error) => void): () => void {
    this.crashListeners.add(listener)
    return () => this.crashListeners.delete(listener)
  }

  command(type: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonValue | undefined> {
    return this.request({ type, params }, signal)
  }

  /**
   * 发送请求（仅 WorkerSession 句柄调用；命令带 sessionId 路由到对应 runtime）。
   */
  request(
    command: { type: string; params?: JsonObject },
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<JsonValue | undefined> {
    if (this.exitHandled) return Promise.reject(this.exitError ?? new Error("Pi worker is not available"))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(Object.assign(new Error("request aborted"), { code: "REQUEST_ABORTED" }))
        return
      }
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        this.pending.delete(id)
        pending?.removeAbort?.()
        // 命令超时：若心跳同时在丢失，说明进程级卡死（事件循环不动）——
        // 立即杀掉重建，而不是让看门狗再等几十秒。若心跳正常，只是单条
        // 命令卡住，废弃这条命令即可（共享进程里还有其他会话）。
        if (this.heartbeatMisses > 0 && !this.exitHandled && !this.disposed) {
          console.error(`[piui-worker] command ${command.type} timed out with heartbeat loss (misses=${this.heartbeatMisses}); killing hung worker`)
          killProcessTree(this.child)
          this.handleExit(null, null, Object.assign(new Error(`Pi worker hung: ${command.type} timed out with heartbeat loss`), {
            code: "SESSION_RUNTIME_CRASHED",
          }))
        }
        reject(Object.assign(new Error(`Pi worker command timed out: ${command.type}`), {
          code: "WORKER_RESULT_UNKNOWN",
        }))
      }, this.options.requestTimeoutMs ?? requestTimeoutMs())
      timer.unref()
      let pending: PendingRequest
      const onAbort = () => {
        if (this.pending.get(id) !== pending) return
        this.pending.delete(id)
        clearTimeout(timer)
        pending.removeAbort?.()
        reject(Object.assign(new Error("request aborted"), { code: "REQUEST_ABORTED" }))
      }
      pending = { resolve, reject, timer }
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true })
        pending.removeAbort = () => signal.removeEventListener("abort", onAbort)
      }
      this.pending.set(id, pending)
      void this.ready.then(helloMessage => {
        if (this.exitHandled || !this.pending.has(id) || signal?.aborted) {
          if (this.pending.get(id) === pending) this.pending.delete(id)
          clearTimeout(timer)
          pending.removeAbort?.()
          if (this.exitHandled) reject(this.exitError ?? new Error("Pi worker is not available"))
          return
        }
        this.child.send({
          kind: "request",
          id,
          generation: helloMessage.generation,
          sessionId,
          command,
        }, error => {
          if (!error) return
          this.pending.delete(id)
          clearTimeout(timer)
          pending.removeAbort?.()
          reject(error)
        })
      }).catch(error => {
        if (this.pending.get(id) !== pending) return
        this.pending.delete(id)
        clearTimeout(timer)
        pending.removeAbort?.()
        reject(error)
      })
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.exitHandled) return
    try {
      // The worker replies only after runtime cleanup. Still wait for the
      // process exit so the parent never kills a worker between its ACK and
      // its final JSONL/provider cleanup.
      const timeout = new Promise<void>(resolve => {
        const timer = setTimeout(resolve, disposeTimeoutMs())
        timer.unref()
      })
      await Promise.race([
        this.request({ type: "dispose" }, undefined, undefined).then(() => this.exited, () => this.exited),
        this.exited,
        timeout,
      ])
    } finally {
      if (!this.exitHandled) {
        killProcessTree(this.child)
        this.handleExit(null, "SIGKILL")
      }
    }
  }
}

/**
 * 每会话 runtime 句柄：公共接口与旧版“每会话一进程”的 WorkerSession 一致，
 * 但背后是共享进程内的一个 runtime（session.close 只关该 runtime，不杀进程）。
 */
export class WorkerSession {
  private readonly eventListeners = new Set<(event: WorkerEvent) => void>()
  private readonly crashListeners = new Set<(error: Error) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly replacementListeners = new Set<(replacement: JsonObject) => void | Promise<void>>()
  private sessionId: string
  private sessionFile?: string
  private cwd?: string
  private disposed = false
  private closeNotified = false
  /** 句柄自己的 hostCall handler（注册到 core 路由表，key = 当前 sessionId） */
  private readonly hostCallHandler: (call: WorkerHostCall) => void | Promise<void>

  /** @internal 由 WorkerHostCore.open 创建 */
  constructor(
    private readonly core: WorkerHostCore,
    identity: { sessionId: string; sessionFile?: string; cwd?: string },
  ) {
    this.sessionId = identity.sessionId
    this.sessionFile = identity.sessionFile
    this.cwd = identity.cwd
    this.hostCallHandler = async (call) => {
      await this.hostCallHandlerImpl?.(call)
      // replacementListeners 由 core.answerHostCall 在 commit 成功后统一触发
      // （dispatchReplacement），这里只做原始 hostCall 应答。
    }
  }

  private hostCallHandlerImpl?: (call: WorkerHostCall) => void | Promise<void>

  static createHost(workerEntry: URL, options?: WorkerClientOptions): WorkerHost {
    const core = new WorkerHostCore(workerEntry, options)
    return {
      getHandshake: () => core.getHandshake(),
      open: (cwd, sessionFile, signal) => core.open(cwd, sessionFile, signal),
      onEvent: listener => core.onEvent(listener),
      onCrash: listener => core.onCrash(listener),
      command: (type, params, signal) => core.command(type, params, signal),
      dispose: () => core.dispose(),
    }
  }

  static createCatalog(workerEntry: URL, options?: WorkerClientOptions): WorkerCatalog {
    const core = new WorkerHostCore(workerEntry, options)
    return {
      command: (type, params, signal) => core.command(type, params, signal),
      getHandshake: () => core.getHandshake(),
      onEvent: listener => core.onEvent(listener),
      onCrash: listener => core.onCrash(listener),
      dispose: () => core.dispose(),
    }
  }

  getSessionId(): string {
    return this.sessionId
  }

  /** After a runtime replacement (fork/clone/new/import), the worker owns a
   * different session — requests must carry the new id or the worker
   * rejects them as RUNTIME_REPLACED. */
  updateSessionIdentity(sessionId: string, sessionFile?: string | null, cwd?: string): void {
    const previous = this.sessionId
    this.sessionId = sessionId
    if (sessionFile !== undefined) this.sessionFile = sessionFile ?? undefined
    if (cwd !== undefined) this.cwd = cwd
    this.core.rebindHandle(this, previous, sessionId)
  }

  getSessionFile(): string | undefined {
    return this.sessionFile
  }

  getCwd(): string {
    return this.cwd ?? ""
  }

  async command(type: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonValue | undefined> {
    return this.core.request({ type, params }, signal, this.sessionId)
  }

  /** 事件分发入口（core 调用，仅本会话事件） */
  dispatchEvent(event: WorkerEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch {
        /* one failed listener must not break the others */
      }
    }
  }

  /** 替换提交事件（core 在 extensionReplacement.commit 成功后调用） */
  async dispatchReplacement(replacement: JsonObject): Promise<void> {
    for (const listener of this.replacementListeners) await listener(replacement)
  }

  /** 进程崩溃（core 调用）：crash + close 都通知 */
  dispatchCrash(error: Error): void {
    if (this.disposed) return
    for (const listener of this.crashListeners) {
      try {
        listener(error)
      } catch {
        /* ignore */
      }
    }
    this.notifyClose()
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
    this.hostCallHandlerImpl = handler
    this.core.setHostCallHandler(this.sessionId, this.hostCallHandler)
  }

  onReplacementCommitted(listener: (replacement: JsonObject) => void | Promise<void>): () => void {
    this.replacementListeners.add(listener)
    return () => this.replacementListeners.delete(listener)
  }

  /**
   * 关闭本句柄对应的 runtime（session.close 命令），不杀共享进程。
   * 幂等：进程已崩溃/已关闭时只做本地清理。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.core.unregisterHandle(this, this.sessionId)
    if (this.core.isGone()) return
    try {
      await this.core.request({ type: "session.close" }, undefined, this.sessionId)
    } catch {
      // runtime 已不可用（进程崩溃/命令失败）：本地清理即可
    }
    this.notifyClose()
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
}

function problemToError(problem: Problem): Error {
  return Object.assign(new Error(problem.message), { code: problem.code, details: problem.details })
}

function spawnSelfWorker(env?: NodeJS.ProcessEnv): ChildProcess {
  const workerBinary = env?.PIUI_WORKER_BIN ?? process.env.PIUI_WORKER_BIN
  if (workerBinary) {
    return spawn(workerBinary, ["--pi-worker"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
    })
  }
  return spawn(process.execPath, ["--pi-worker"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    windowsHide: true,
  })
}
