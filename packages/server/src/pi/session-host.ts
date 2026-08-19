import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { open } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { CommandEnvelope, CommandRecord, JsonObject, JsonValue, PiCapability, PiRegistrySnapshot, RegistrySnapshot, SessionActivityStatus, SessionsActivitySnapshot } from "@piui/protocol"
import { isJsonObject, PI_PARITY_SDK_VERSION, PROTOCOL_VERSION, validateParams } from "@piui/protocol"
import { createRegistryDescribeCapability, getCommandCapability, getDriverMode, listCommandCapabilities, type WorkerEvent } from "@piui/pi-worker"
import type { EventHub } from "../event-hub.ts"
import type { RuntimeSupervisor } from "./supervisor.ts"
import { SessionExecutor, type SubmittedCommand } from "./session-executor.ts"
import { SessionRuntimeRegistry, type AttachedSession } from "./session-registry.ts"

const SERVER_GLOBAL_CAPABILITIES: PiCapability[] = [
  {
    name: "session.open",
    scope: "global",
    source: "piui-adapter",
    description: "Attach or create a Pi session runtime",
    paramsSchema: {
      type: "object",
      additionalProperties: true,
      required: ["cwd"],
      properties: { cwd: { type: "string" }, sessionFile: { type: "string" }, reuseFromSessionId: { type: "string" } },
    },
    queue: "immediate",
  },
  {
    name: "session.attached",
    scope: "global",
    source: "piui-adapter",
    description: "List Pi session ids currently attached to this PiUI server",
    paramsSchema: { type: "object", additionalProperties: false, properties: {} },
    queue: "immediate",
  },
]

const SERVER_SESSION_CAPABILITIES: PiCapability[] = [{
  name: "session.close",
  scope: "session",
  source: "piui-adapter",
  description: "Detach a Pi session runtime from PiUI",
  paramsSchema: { type: "object", additionalProperties: false, properties: {} },
  queue: "immediate",
}]

const DEFAULT_IDLE_RUNTIME_TTL_MS = 2 * 60_000
const RUNTIME_REAPER_INTERVAL_MS = 30_000
const ATTACH_BUSY_RETRIES = 12
const ATTACH_BUSY_DELAY_MS = 100

function idleRuntimeTtlMs(): number {
  const configured = Number(process.env.PIUI_SESSION_IDLE_TTL_MS)
  return Number.isFinite(configured) && configured >= 30_000
    ? configured
    : DEFAULT_IDLE_RUNTIME_TTL_MS
}

export class SessionHost {
  private readonly runtimes = new SessionRuntimeRegistry()
  private readonly activity = new Map<string, SessionActivityStatus>()
  private readonly lastAccess = new Map<string, number>()
  private readonly materialized = new Set<string>()
  private readonly runtimeReaper: NodeJS.Timeout
  readonly executor: SessionExecutor

  constructor(
    private readonly supervisor: RuntimeSupervisor,
    private readonly hub: EventHub,
  ) {
    this.executor = new SessionExecutor(record => this.emitCommandUpdate(record))
    this.supervisor.onEvent(event => this.routeCatalogEvent(event))
    this.runtimeReaper = setInterval(() => {
      void this.reapIdleRuntimes()
    }, RUNTIME_REAPER_INTERVAL_MS)
    this.runtimeReaper.unref?.()
  }

  async openSession(cwd: string, sessionFile?: string, signal?: AbortSignal, reuseFromSessionId?: string): Promise<JsonObject> {
    if (sessionFile && reuseFromSessionId) {
      const switched = await this.switchAttachedSession(reuseFromSessionId, cwd, sessionFile, signal)
      if (switched) return switched
    }
    if (!sessionFile) {
      // 单共享 worker 进程：runtime 常驻，open 只是进程内建 runtime，
      // 无需 warm/prewarm（旧架构里预热一个 300MB 的独立进程）。
      return this.openSessionOnce(cwd, sessionFile, signal)
    }
    return this.runtimes.openFlight(sessionFile, openSignal => this.openSessionOnce(cwd, sessionFile, openSignal), signal)
  }

  private async switchAttachedSession(
    sourceSessionId: string,
    cwd: string,
    sessionFile: string,
    signal?: AbortSignal,
  ): Promise<JsonObject | undefined> {
    const source = this.runtimes.get(sourceSessionId)
    if (!source || (source.sessionFile && pathKey(source.sessionFile) === pathKey(sessionFile))) return undefined
    if (this.activity.has(sourceSessionId) || this.executor.hasPendingWork(sourceSessionId) || this.executor.isClosing(sourceSessionId)) {
      return undefined
    }
    if (!source.sessionFile || pathKey(dirname(source.sessionFile)) !== pathKey(dirname(sessionFile))) return undefined

    const result = await source.worker.command("switchSession", { sessionPath: sessionFile, cwdOverride: cwd }, signal)
    await this.trackReplacement(source, result)
    const target = this.requireAttached(source.sessionId)
    const state = await target.worker.command("state.get", undefined, signal) as JsonObject | undefined
    return {
      sessionId: target.sessionId,
      sessionFile: target.sessionFile ?? null,
      sessionFileReady: Boolean(target.sessionFile && existsSync(target.sessionFile)),
      cwd: target.cwd,
      state: state ?? null,
    }
  }

  private async openSessionOnce(cwd: string, sessionFile?: string, signal?: AbortSignal): Promise<JsonObject> {
    // Idempotent attach: reopening an already-attached session file reuses
    // its runtime instead of spawning a second worker that would lose the
    // session lease (SESSION_BUSY 409).
    if (sessionFile) {
      const existing = this.runtimes.findBySessionFile(sessionFile)
      if (existing) {
        if (this.executor.isClosing(existing.sessionId)) {
          throw Object.assign(new Error("session runtime is closing"), { code: "RUNTIME_CLOSING" })
        }
        this.touch(existing.sessionId)
        const state = await existing.worker.command("state.get") as JsonObject | undefined
        return {
          sessionId: existing.sessionId,
          sessionFile: existing.sessionFile ?? null,
          sessionFileReady: Boolean(existing.sessionFile && existsSync(existing.sessionFile)),
          cwd: existing.cwd,
          state: state ?? null,
        }
      }
    }
    let worker: Awaited<ReturnType<RuntimeSupervisor["open"]>> | undefined
    try {
      worker = await this.supervisor.open(cwd, sessionFile, signal)
      const state = await worker.command("state.get", undefined, signal) as JsonObject | undefined
      const session: AttachedSession = {
        sessionId: worker.getSessionId(),
        cwd: worker.getCwd() || cwd,
        sessionFile: worker.getSessionFile() ?? sessionFile,
        worker,
      }
      this.attach(session)
      return {
        sessionId: session.sessionId,
        sessionFile: session.sessionFile ?? null,
        sessionFileReady: Boolean(session.sessionFile && existsSync(session.sessionFile)),
        cwd: session.cwd,
        state: state ?? null,
      }
    } catch (error) {
      await worker?.dispose().catch(() => undefined)
      throw error
    }
  }

  private attach(session: AttachedSession): void {
    this.executor.resetSession(session.sessionId)
    this.runtimes.set(session)
    this.touch(session.sessionId)
    // A session file that already exists is visible to the disk-scanning
    // session list; only fresh sessions need the materialized broadcast.
    if (session.sessionFile && existsSync(session.sessionFile)) {
      this.materialized.add(session.sessionId)
    }
    session.worker.onReplacementCommitted?.(replacement => this.trackReplacement(session, replacement, { leaseCommitted: true }))
    session.worker.onEvent(event => this.routeSessionEvent(session, event))
    session.worker.onCrash(() => {
      this.executor.markRuntimeCrashed(session.sessionId)
      this.runtimes.delete(session.sessionId)
      this.activity.delete(session.sessionId)
      this.lastAccess.delete(session.sessionId)
      // Dispose so the process exits and the supervisor releases the lease —
      // without this a crashed runtime orphans the session (permanent
      // SESSION_BUSY on reattach).
      void session.worker.dispose().catch(() => undefined)
      this.publishActivity()
      this.hub.publish({ kind: "session", id: session.sessionId }, "sessions.updated", {
        sessionId: session.sessionId,
        crashed: true,
      })
    })
    session.worker.onClose(() => {
      const wasAttached = this.runtimes.delete(session.sessionId)
      const hadActivity = this.activity.delete(session.sessionId)
      this.lastAccess.delete(session.sessionId)
      if (!wasAttached && !hadActivity) return
      this.publishActivity()
      this.hub.publish({ kind: "server", id: "server" }, "sessions.updated", {
        sessionId: session.sessionId,
        detached: true,
      })
    })
    this.hub.publish({ kind: "server", id: "server" }, "sessions.updated", {
      sessionId: session.sessionId,
      attached: true,
      cwd: session.cwd,
    })
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.runtimes.get(sessionId)
    if (!session) throw Object.assign(new Error("session is not attached"), { code: "SESSION_NOT_FOUND" })
    this.lastAccess.delete(sessionId)
    await this.executor.close(sessionId, {
      interrupt: async () => {
        await session.worker.command("abort").catch(() => undefined)
      },
      dispose: async () => {
        this.runtimes.delete(sessionId)
        this.activity.delete(sessionId)
        await session.worker.dispose()
        this.hub.publish({ kind: "server", id: "server" }, "sessions.updated", {
          sessionId,
          detached: true,
        })
      },
    })
  }

  getAttached(sessionId: string): AttachedSession | undefined {
    return this.runtimes.get(sessionId)
  }

  listAttachedIds(): string[] {
    return [...this.runtimes.keys()]
  }

  requireAttached(sessionId: string): AttachedSession {
    const session = this.runtimes.get(sessionId)
    if (!session) {
      throw Object.assign(new Error("session is not attached"), { code: "SESSION_NOT_FOUND" })
    }
    return session
  }

  async sessionQuery(sessionId: string, type: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonValue | undefined> {
    return withAbort((async () => {
      const session = await this.ensureAttached(sessionId, signal)
      this.touch(session.sessionId)
      if (this.executor.isClosing(sessionId)) {
        throw Object.assign(new Error("session runtime is closing"), { code: "RUNTIME_CLOSING" })
      }
      const capability = this.getSessionCapability(type)
      if (capability?.queue !== "immediate") {
        throw Object.assign(new Error(`${type} is not a query command`), { code: "INVALID_REQUEST" })
      }
      return session.worker.command(type, params, signal)
    })(), signal)
  }

  /**
   * Self-heal attach: when a session isn't attached (e.g. after a server
   * restart, or a client deep-linking to a session id), locate it on disk
   * via the global session list and attach it before failing.
   */
  private async ensureAttached(sessionId: string, signal?: AbortSignal): Promise<AttachedSession> {
    const existing = this.runtimes.get(sessionId)
    if (existing) return existing
    // Single-flight: concurrent queries (state.get + branch.get fire together)
    // must share one attach, or the second worker loses the session lease
    // with SESSION_BUSY.
    return this.runtimes.attachFlight(sessionId, async (): Promise<AttachedSession> => {
      const found = await this.findSessionOnDisk(sessionId)
      if (!found) {
        throw Object.assign(new Error("session is not attached"), { code: "SESSION_NOT_FOUND" })
      }
      let lastError: unknown
      for (let attempt = 0; attempt <= ATTACH_BUSY_RETRIES; attempt += 1) {
        try {
          // 复用现有进程：目标未 attach 时，优先把同目录空闲的已 attach worker
          // 切身份过去（switchSession），而不是新开一个——切 session 不单开。
          // 源 worker 忙/异目录时 switch 自动失败，回落正常 open（不影响正在工作）。
          const reusable = this.findReusableRuntime(found.sessionFile)
          await this.openSession(found.cwd, found.sessionFile, signal, reusable?.sessionId)
          return this.requireAttached(sessionId)
        } catch (error) {
          lastError = error
          if (!isSessionBusyError(error) || attempt === ATTACH_BUSY_RETRIES) throw error
          await waitForRetry(ATTACH_BUSY_DELAY_MS, signal)
          const attached = this.runtimes.get(sessionId)
          if (attached) return attached
        }
      }
      throw lastError
    })
  }

  /**
   * 找一个可以复用的已 attach 空闲 worker：同目录、未在工作、不在关闭中。
   * 用它承载目标 session（switchSession 切身份），避免每次切 session 新开进程。
   */
  private findReusableRuntime(sessionFile: string): AttachedSession | undefined {
    const targetPath = pathKey(sessionFile)
    const targetDir = pathKey(dirname(sessionFile))
    for (const session of this.runtimes.values()) {
      if (!session.sessionFile) continue
      if (pathKey(session.sessionFile) === targetPath) continue // 目标自己已 attach：幂等复用，不走 switch
      if (pathKey(dirname(session.sessionFile)) !== targetDir) continue // 异目录：worker 绑定 cwd，不可切
      if (this.activity.has(session.sessionId)) continue
      if (this.executor.hasPendingWork(session.sessionId)) continue
      if (this.executor.isClosing(session.sessionId)) continue
      return session
    }
    return undefined
  }

  private async findSessionOnDisk(sessionId: string): Promise<{ cwd: string; sessionFile: string } | undefined> {
    try {
      const listed = await this.catalogCommand("session.listAll", undefined, { retry: true, idempotent: true })
      if (Array.isArray(listed)) {
        const match = listed.find(item => isJsonObject(item) && item.id === sessionId)
        if (isJsonObject(match)) {
          const sessionFile = typeof match.path === "string"
            ? match.path
            : typeof match.sessionFile === "string" ? match.sessionFile : undefined
          const cwd = typeof match.cwd === "string" ? match.cwd : undefined
          if (sessionFile && cwd) return { cwd, sessionFile }
        }
      }
    } catch {
      // Fall back to the legacy default directory scan below.
    }

    // Scan the Pi sessions directory directly for `<ts>_<sessionId>.jsonl` —
    // more reliable than the catalog list, and reads cwd from the file header.
    try {
      const root = join(homedir(), ".pi", "agent", "sessions")
      const suffix = `_${sessionId}.jsonl`
      const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue
        const files = await readdir(join(root, dir.name)).catch(() => [])
        const match = files.find(file => file.endsWith(suffix))
        if (!match) continue
        const sessionFile = join(root, dir.name, match)
        const firstLine = await readFirstLine(sessionFile)
        const cwd = firstLine ? parseHeaderCwd(firstLine) : undefined
        if (cwd) return { cwd, sessionFile }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  async piRegistry(signal?: AbortSignal): Promise<PiRegistrySnapshot> {
    // worker 未就绪（冷启动 SDK 加载中）时立即返回静态快照：命令能力表是
    // 编译期静态的（@piui/protocol 的 PI_COMMAND_SPECS），不需要 worker。
    // 否则前端 bootstrap 会被 worker 的数秒 SDK 加载卡住，触发退避重试。
    // sdkVersion 用 parity 常量兜底；worker 就绪后走真实 describeRegistry。
    const ready = await this.supervisor.peekCatalogHandshake().catch(() => undefined)
    if (!ready) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        revision: 1,
        sdkVersion: PI_PARITY_SDK_VERSION,
        driver: getDriverMode(),
        globalCommands: mergeCapabilities(SERVER_GLOBAL_CAPABILITIES, [
          createRegistryDescribeCapability(),
          ...listCommandCapabilities("global"),
        ]),
        sessionCommands: mergeCapabilities(SERVER_SESSION_CAPABILITIES, listCommandCapabilities("session")),
      }
    }
    const data = await this.catalogCommand("registry.describe", undefined, { retry: true, idempotent: true, signal }) as PiRegistrySnapshot | undefined
    if (!data || typeof data !== "object") {
      throw Object.assign(new Error("Pi registry is unavailable"), { code: "REGISTRY_UNAVAILABLE" })
    }
    return {
      ...data,
      globalCommands: mergeCapabilities(SERVER_GLOBAL_CAPABILITIES, data.globalCommands),
      sessionCommands: mergeCapabilities(SERVER_SESSION_CAPABILITIES, data.sessionCommands),
    }
  }

  async executeGlobalCommand(type: string, params?: JsonObject, options: { signal?: AbortSignal } = {}): Promise<JsonValue | undefined> {
    if (type === "session.open") {
      const cwd = typeof params?.cwd === "string" ? params.cwd : undefined
      if (!cwd) throw Object.assign(new Error("params.cwd must be a non-empty string"), { code: "INVALID_REQUEST" })
      const sessionFile = typeof params?.sessionFile === "string" ? params.sessionFile : undefined
      const reuseFromSessionId = typeof params?.reuseFromSessionId === "string" ? params.reuseFromSessionId : undefined
      return this.openSession(cwd, sessionFile, options.signal, reuseFromSessionId)
    }
    if (type === "session.attached") return this.listAttachedIds()
    if (type === "session.delete") {
      // Detach a live runtime before the file goes away: an attached worker
      // keeps serving the session from memory and would rewrite the file on
      // its next append, resurrecting the deleted session.
      const sessionFile = typeof params?.sessionFile === "string" ? params.sessionFile : undefined
      if (sessionFile) {
        const live = this.runtimes.findBySessionFile(sessionFile)
        if (live) await this.closeSession(live.sessionId)
      }
    }
    const capability = getCommandCapability(type)
    if (SERVER_SESSION_CAPABILITIES.some(item => item.name === type) || capability?.scope === "session") {
      throw Object.assign(new Error(`unknown global command: ${type}`), { code: "UNKNOWN_COMMAND" })
    }
    validateParams(capability?.paramsSchema, params ?? {})
    const idempotent = type === "registry.describe" || capability?.idempotent === true
    return this.catalogCommand(type, params, { retry: idempotent, idempotent, signal: options.signal })
  }

  executeSessionCommand(sessionId: string, type: string, params?: JsonObject, id?: string, options: { signal?: AbortSignal } = {}): JsonValue | SubmittedCommand | Promise<JsonValue | SubmittedCommand | undefined> {
    if (type === "session.close") {
      return withAbort(this.closeSession(sessionId), options.signal).then(() => ({ ok: true }))
    }
    const capability = this.getSessionCapability(type)
    if (!capability) return this.dispatchExtensionCommand(sessionId, type, params, id, options)
    validateParams(capability.paramsSchema, params ?? {})
    if (capability.queue === "immediate") return this.sessionQuery(sessionId, type, params, options.signal)
    return this.submitSessionCommand(sessionId, { id: id ?? randomUUID(), type, params })
  }

  /**
   * 静态命令表未命中：对照该会话 Pi 运行时自己的注册表（loader.getExtensions
   * 的结果）原生路由扩展命令/工具——PiUI 不做第二份镜像。注册过才提交执行；
   * 冷会话（未 attach）不因一个未知命令而孵化 worker。
   */
  private async dispatchExtensionCommand(
    sessionId: string,
    type: string,
    params?: JsonObject,
    id?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SubmittedCommand> {
    const existing = this.runtimes.get(sessionId)
    if (!existing) {
      throw Object.assign(new Error(`unknown command: ${type}`), { code: "UNKNOWN_COMMAND" })
    }
    const registry = await existing.worker.command("registry.get", undefined, options.signal) as RegistrySnapshot | undefined
    if (!registry) throw Object.assign(new Error(`unknown command: ${type}`), { code: "UNKNOWN_COMMAND" })
    const tool = registry.tools.find(item => item.name === type)
    const command = registry.commands.find(item => item.name === type)
    if (!tool && !command) throw Object.assign(new Error(`unknown command: ${type}`), { code: "UNKNOWN_COMMAND" })
    // 工具参数 schema 来自 Pi 自己的工具定义——在 HTTP 边界校验，畸形入参直接 400。
    if (tool?.parameters) validateParams(tool.parameters, params ?? {})
    return this.submitSessionCommand(sessionId, { id: id ?? randomUUID(), type, params })
  }

  submitSessionCommand(sessionId: string, envelope: Omit<CommandEnvelope, "sessionId">): SubmittedCommand | Promise<SubmittedCommand> {
    const full: CommandEnvelope = { ...envelope, sessionId }
    const submit = (session: AttachedSession): SubmittedCommand => {
      this.touch(session.sessionId)
      return this.executor.submit(full, async () => {
        const data = await session.worker.command(full.type, full.params)
        await this.trackReplacement(session, data)
        return data
      })
    }
    const existing = this.runtimes.get(sessionId)
    if (existing) return submit(existing)
    return this.ensureAttached(sessionId).then(submit)
  }

  getCommand(commandId: string): CommandRecord | undefined {
    return this.executor.get(commandId)
  }

  async catalogCommand(type: string, params?: JsonObject, options?: { retry?: boolean; idempotent?: boolean; signal?: AbortSignal }): Promise<JsonValue | undefined> {
    return this.supervisor.catalogCommand(type, params, options)
  }

  private getSessionCapability(type: string): PiCapability | undefined {
    const capability = SERVER_SESSION_CAPABILITIES.find(item => item.name === type) ?? getCommandCapability(type)
    return capability?.scope === "session" ? capability : undefined
  }

  private async trackReplacement(
    session: AttachedSession,
    data: JsonValue | undefined,
    options: { leaseCommitted?: boolean } = {},
  ): Promise<void> {
    if (!isJsonObject(data) || data.cancelled !== false || typeof data.targetSessionId !== "string") return
    if (data.targetSessionId === session.sessionId) return
    const sourceSessionId = session.sessionId
    const targetSessionId = data.targetSessionId
    const target = this.runtimes.get(targetSessionId)
    if (target && target !== session) {
      const error = Object.assign(new Error("replacement target session is already attached"), { code: "SESSION_BUSY" })
      setImmediate(() => { void session.worker.dispose() })
      throw error
    }
    const targetSessionFile = Object.prototype.hasOwnProperty.call(data, "targetSessionFile")
      ? (typeof data.targetSessionFile === "string" ? data.targetSessionFile : null)
      : session.sessionFile
    const targetCwd = typeof data.targetCwd === "string" ? data.targetCwd : session.cwd

    try {
      // Extension replacements have already committed their reservation in
      // supervisor.ts. Ordinary commands still need to move the lease here.
      if (!options.leaseCommitted) {
        await this.supervisor.replaceRuntimeLease(session.worker, targetSessionFile, targetSessionId)
      }

      const previousLastAccess = this.lastAccess.get(sourceSessionId)
      const previousActivity = this.activity.get(sourceSessionId)
      const wasMaterialized = this.materialized.delete(sourceSessionId)
      this.lastAccess.delete(sourceSessionId)
      this.activity.delete(sourceSessionId)
      this.runtimes.delete(sourceSessionId)
      this.executor.resetSession(targetSessionId)

      session.sessionId = targetSessionId
      session.sessionFile = targetSessionFile ?? undefined
      session.cwd = targetCwd
      session.worker.updateSessionIdentity(session.sessionId, session.sessionFile, session.cwd)
      if (previousLastAccess !== undefined) this.lastAccess.set(targetSessionId, previousLastAccess)
      if (previousActivity !== undefined) this.activity.set(targetSessionId, previousActivity)
      if (wasMaterialized) this.materialized.add(targetSessionId)
      this.runtimes.set(session)
      this.hub.publish({ kind: "server", id: "server" }, "sessions.updated", {
        replaced: true,
        sourceSessionId: typeof data.sourceSessionId === "string" ? data.sourceSessionId : sourceSessionId,
        targetSessionId,
        targetSessionFile: session.sessionFile,
        targetCwd: session.cwd,
      })
    } catch (error) {
      // The SDK has already changed identity. A failed parent-side commit
      // cannot be rolled back safely, so stop this worker before it can write.
      setImmediate(() => { void session.worker.dispose() })
      throw error
    }
  }

  private routeSessionEvent(session: AttachedSession, event: WorkerEvent): void {
    this.touch(session.sessionId)
    if (event.channel === "pi.event") {
      this.hub.publish({ kind: "session", id: session.sessionId }, "pi.event", {
        event: event.event,
        meta: event.meta,
      })
      return
    }
    if (event.channel === "session.activity") {
      this.trackActivity(session.sessionId, event.event)
      return
    }
    if (event.channel === "session.head") {
      this.hub.publish({ kind: "session", id: session.sessionId }, "session.head", event.head)
      // 列表 = 磁盘扫描：只有会话文件真的存在（首个条目落盘）才广播
      // materialized。head 事件来自内存 entries（setSessionName 等操作
      // 只改内存不改文件），不能当作落盘信号——否则前端重拉后磁盘还是
      // 扫不到，列表永远不出现。
      if (!this.materialized.has(session.sessionId) && session.sessionFile && existsSync(session.sessionFile)) {
        this.materialized.add(session.sessionId)
        this.hub.publish({ kind: "server", id: "server" }, "sessions.updated", {
          sessionId: session.sessionId,
          materialized: true,
        })
      }
      return
    }
    if (event.channel === "extension.ui") {
      this.hub.publish({ kind: "session", id: session.sessionId }, "extension.ui", event.event)
      return
    }
    if (event.channel === "registry.updated") {
      this.hub.publish({ kind: "session", id: session.sessionId }, "registry.updated", event.event)
      return
    }
    this.routeCatalogEvent(event)
  }

  private routeCatalogEvent(event: WorkerEvent): void {
    if (event.channel === "provider.auth") {
      const providerId = isJsonObject(event.event) && typeof event.event.providerId === "string"
        ? event.event.providerId
        : "global"
      this.hub.publish({ kind: "provider", id: providerId }, "provider.auth", event.event)
      return
    }
    if (event.channel === "packages.progress") {
      this.hub.publish({ kind: "server", id: "server" }, "packages.progress", event.event)
      return
    }
    if (event.channel === "resources.updated") {
      this.hub.publish({ kind: "server", id: "server" }, "resources.updated", {
        workspacePath: "workspacePath" in event ? event.workspacePath ?? null : null,
      })
    }
  }

  /**
   * Aggregate worker-reported activity status (derived from SDK isStreaming/
   * isRetrying on the worker side) and broadcast full snapshots on change.
   */
  private trackActivity(sessionId: string, event: JsonValue | undefined): void {
    const status = isJsonObject(event) && isJsonObject(event.status) ? event.status : null
    const previous = this.activity.get(sessionId)
    const next = status as SessionActivityStatus | null
    if (next) this.touch(sessionId)

    const changed = next === null
      ? previous !== undefined
      : !previous || previous.type !== next.type
    if (next) this.activity.set(sessionId, next)
    else this.activity.delete(sessionId)
    if (changed) this.publishActivity()
  }

  getActivitySnapshot(): SessionsActivitySnapshot {
    return { sessions: Object.fromEntries(this.activity) }
  }

  private publishActivity(): void {
    this.hub.publish({ kind: "server", id: "server" }, "sessions.activity", this.getActivitySnapshot() as unknown as JsonValue)
  }

  dispose(): void {
    clearInterval(this.runtimeReaper)
    this.lastAccess.clear()
    this.activity.clear()
    this.materialized.clear()
  }

  private touch(sessionId: string): void {
    this.lastAccess.set(sessionId, Date.now())
  }

  private async reapIdleRuntimes(): Promise<void> {
    const cutoff = Date.now() - idleRuntimeTtlMs()
    const candidates = [...this.runtimes.values()].filter(session => {
      const last = this.lastAccess.get(session.sessionId) ?? 0
      return last < cutoff
        && !this.activity.has(session.sessionId)
        && !this.executor.hasPendingWork(session.sessionId)
        && !this.executor.isClosing(session.sessionId)
    })

    for (const session of candidates) {
      // 双保险：向 worker 确认确实无未完成工作再回收。activity 是事件驱动
      // 上报（可能有延迟/遗漏），state.get 是 SDK 同步真相源——isStreaming
      // （agent run 活跃）、isBashRunning（长 bash 在跑）、pendingMessageCount
      // （队列有消息）任一成立都跳过，绝不误杀正在工作的会话。
      let stillBusy = false
      try {
        const state = await session.worker.command("state.get") as JsonObject | undefined
        if (state) {
          stillBusy = state.isStreaming === true
            || state.isBashRunning === true
            || Number(state.pendingMessageCount ?? 0) > 0
        }
      } catch {
        // worker 已不可用（崩溃/断开）：回收无妨
      }
      if (stillBusy) {
        this.touch(session.sessionId)
        continue
      }
      const cwd = session.cwd
      await this.closeSession(session.sessionId).catch(() => undefined)
      // 单共享进程下无需补 warm：worker 常驻，下次 attach 只是进程内建
      // runtime（旧架构里回收后补预热是为了避免冷启动新进程）。
    }
  }

  private emitCommandUpdate(record: CommandRecord): void {
    const stream = record.sessionId
      ? { kind: "session" as const, id: record.sessionId }
      : { kind: "server" as const, id: "server" }
    this.hub.publish(stream, "command.updated", record as unknown as JsonValue)
  }
}

function mergeCapabilities(local: PiCapability[], remote: PiCapability[]): PiCapability[] {
  const merged = new Map<string, PiCapability>()
  for (const capability of remote) merged.set(capability.name, capability)
  for (const capability of local) merged.set(capability.name, capability)
  return [...merged.values()]
}

async function readFirstLine(filePath: string): Promise<string | undefined> {
  try {
    const handle = await open(filePath, "r")
    try {
      const iterator = handle.readLines({ encoding: "utf8" })[Symbol.asyncIterator]()
      const { value } = await iterator.next()
      return value
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

function parseHeaderCwd(line: string): string | undefined {
  try {
    const header = JSON.parse(line) as { cwd?: unknown }
    return typeof header.cwd === "string" && header.cwd ? header.cwd : undefined
  } catch {
    return undefined
  }
}

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
    operation.then(
      value => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

function abortError(): Error {
  return Object.assign(new Error("request aborted"), { code: "REQUEST_ABORTED" })
}

function pathKey(path: string): string {
  const resolved = resolve(path)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isSessionBusyError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "SESSION_BUSY")
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? abortError()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }, delayMs)
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      reject(signal?.reason ?? abortError())
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
