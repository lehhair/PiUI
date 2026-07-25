import { randomUUID } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { unlink } from "node:fs/promises"
import path from "node:path"
import type {
  PiSessionEntryV1,
  PiSessionTreeNodeV1,
  SessionReplacementResultV1,
  SessionSnapshotV1,
  TimelineItemV1,
} from "@piui/protocol"
import {
  applyWorkerEvent,
  createProjectionState,
  getDriverMode,
  runMockTurn,
  type DriverMode,
  type PiModelInfo,
  type PiSessionInfo,
  type PiSessionRuntime,
  type ProjectionState,
} from "@piui/pi-worker"
import type { WorkspaceStore } from "./workspace-store.ts"
import type { EventHub } from "./event-hub.ts"

export interface AppSession {
  id: string
  workspaceId: string
  driverSessionId: string
  title: string
  createdAt: string
  updatedAt: string
  epoch: string
  sequence: number
  projection: ProjectionState
  driver: DriverMode
  sessionFile?: string
  real?: PiSessionRuntime
  workerGeneration?: string
  runtimeError?: string
  nativeEntries?: PiSessionEntryV1[]
  nativeTree?: PiSessionTreeNodeV1[]
  nativeLeafId?: string | null
}

export interface PiSessionBackend {
  list?(cwd: string): Promise<PiSessionInfo[]>
  listAll(): Promise<PiSessionInfo[]>
  listModels?(): Promise<PiModelInfo[]>
  open(cwd: string, sessionFile?: string): Promise<PiSessionRuntime>
  dispose?(): Promise<void>
}

const DISCOVERY_TTL_MS = 5_000

export class SessionRegistry {
  private readonly byId = new Map<string, AppSession>()
  private readonly attaching = new Map<string, Promise<PiSessionRuntime>>()
  private readonly discovering = new Map<string, Promise<void>>()
  private readonly discoveredAt = new Map<string, number>()
  private readonly hiddenIds = new Set<string>()
  private readonly deleting = new Set<string>()
  private readonly runtimeDisposals = new WeakMap<PiSessionRuntime, Promise<void>>()
  private readonly runtimeBindings = new Map<string, {
    runtime: PiSessionRuntime
    unsubscribe: () => void
  }>()
  private readonly driver: DriverMode
  private backendPromise?: Promise<PiSessionBackend>

  constructor(
    private readonly workspaces: WorkspaceStore,
    driver: DriverMode = getDriverMode(),
    private readonly injectedBackend?: PiSessionBackend,
    private readonly eventHub?: EventHub,
    private readonly onRuntimeCrash?: (sessionId: string, workerGeneration: string | undefined, error: Error) => void,
  ) {
    this.driver = driver
  }

  getDriver(): DriverMode {
    return this.driver
  }

  async warmup(): Promise<void> {
    await this.discover()
  }

  async list(workspaceId?: string): Promise<AppSession[]> {
    if (workspaceId) {
      const workspace = this.workspaces.get(workspaceId)
      if (!workspace) return []
      await this.discover(workspace.canonicalRoot)
    } else {
      await this.discover()
    }
    const all = [...this.byId.values()]
    return workspaceId ? all.filter(s => s.workspaceId === workspaceId) : all
  }

  async listModels(): Promise<PiModelInfo[]> {
    if (this.driver !== "pi") return []
    const backend = await this.getBackend()
    return backend.listModels?.() ?? []
  }

  get(id: string): AppSession | undefined {
    return this.byId.get(id)
  }

  async delete(id: string): Promise<boolean> {
    const s = this.byId.get(id)
    if (!s) return false
    this.hiddenIds.add(id)
    this.deleting.add(id)
    this.byId.delete(id)
    this.unbindRuntime(s)
    const attached = s.real
    s.real = undefined
    s.workerGeneration = undefined
    const pending = this.attaching.get(id)
    try {
      await Promise.all([
        attached ? this.disposeRuntime(attached) : Promise.resolve(),
        pending?.then(runtime => this.disposeRuntime(runtime)) ?? Promise.resolve(),
      ])
      if (s.driver === "pi" && s.sessionFile) {
        try {
          await unlink(s.sessionFile)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
    } catch (error) {
      this.hiddenIds.delete(id)
      this.byId.set(id, s)
      throw error
    } finally {
      this.deleting.delete(id)
    }
    return true
  }

  /**
   * Create session.
   * - mock: optional seed turn, no LLM
   * - pi: opens real AgentSessionRuntime (models when prompted)
   */
  async create(
    workspaceId: string,
    opts?: { title?: string; seedMock?: boolean },
  ): Promise<AppSession> {
    const ws = this.workspaces.get(workspaceId)
    if (!ws) {
      throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" as const })
    }
    const now = new Date().toISOString()
    let projection = createProjectionState()
    let sequence = 0
    let real: PiSessionRuntime | undefined
    let driverSessionId = `mock-${randomUUID().slice(0, 8)}`

    if (this.driver === "pi") {
      const backend = await this.getBackend()
      real = await backend.open(ws.canonicalRoot)
      driverSessionId = real.getSessionId()
      projection = real.getProjection()
    } else if (opts?.seedMock === true) {
      for (const ev of runMockTurn({
        userText: "hello from mock",
        assistantText: "this is a mock assistant reply",
        thinking: "mock think",
        tool: { name: "read", args: { path: "README.md" }, result: "# mock\n" },
      })) {
        projection = applyWorkerEvent(projection, ev)
        sequence++
      }
    }

    const seedMock = opts?.seedMock === true && this.driver === "mock"
    const session: AppSession = {
      id: driverSessionId,
      workspaceId,
      driverSessionId,
      title: opts?.title ?? (seedMock ? "Mock session" : "New chat"),
      createdAt: now,
      updatedAt: now,
      epoch: randomUUID(),
      sequence,
      projection,
      driver: this.driver,
      sessionFile: real?.getSessionFile(),
      real: undefined,
    }
    this.byId.set(session.id, session)
    if (real) this.bindRuntime(session, real)
    return session
  }

  async prompt(
    sessionId: string,
    text: string,
    opts?: {
      stream?: boolean
      onTick?: (session: AppSession) => void
      delayMs?: number
      model?: { provider?: string; id?: string }
      deliverAs?: "steer" | "followUp"
    },
  ): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const trimmed = text.trim()
    if (!trimmed) {
      throw Object.assign(new Error("empty prompt"), { code: "INVALID_REQUEST" as const })
    }

    if (session.real) {
      const runtime = session.real
      const generation = session.workerGeneration
      try {
        if (opts?.model?.provider && opts.model.id) {
          await runtime.setModel(opts.model.provider, opts.model.id)
        }
        await runtime.prompt(
          trimmed,
          projection => {
            if (!this.isCurrentRuntime(session, runtime, generation)) return
            session.projection = projection
            session.sequence += 1
            session.updatedAt = new Date().toISOString()
            opts?.onTick?.(session)
          },
          { deliverAs: opts?.deliverAs },
        )
      } catch (e) {
        if (!this.isCurrentRuntime(session, runtime, generation)) throw runtimeReplacedError()
        const msg = e instanceof Error ? e.message : String(e)
        const code = e && typeof e === "object" && "code" in e ? String(e.code) : "INTERNAL"
        throw Object.assign(new Error(msg), { code })
      }
      if (!this.isCurrentRuntime(session, runtime, generation)) throw runtimeReplacedError()
      session.projection = runtime.getProjection()
      session.sessionFile = runtime.getSessionFile() ?? session.sessionFile
      session.title = runtime.getSessionName() ?? session.title
      if (session.title === "New chat" || session.title === "Mock session" || session.title === "Mock chat") {
        session.title = trimmed.slice(0, 48)
      }
      session.sequence += 1
      session.updatedAt = new Date().toISOString()
      opts?.onTick?.(session)
      return session
    }

    // mock path — no LLM
    let projection = session.projection
    const events = runMockTurn({
      userText: trimmed,
      assistantText: `mock reply: ${trimmed.slice(0, 200)}`,
      thinking: "mock thinking",
    })
    const delay = opts?.stream ? (opts.delayMs ?? 25) : 0
    for (const ev of events) {
      projection = applyWorkerEvent(projection, ev)
      session.sequence += 1
      session.projection = projection
      session.updatedAt = new Date().toISOString()
      opts?.onTick?.(session)
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
    }
    if (session.title === "Mock session" || session.title === "Mock chat" || session.title === "New chat") {
      session.title = trimmed.slice(0, 48)
    }
    session.sequence += 1
    session.updatedAt = new Date().toISOString()
    opts?.onTick?.(session)
    return session
  }

  async abort(sessionId: string): Promise<AppSession | undefined> {
    const session = await this.find(sessionId)
    if (!session) return undefined
    await this.attach(sessionId)
    const runtime = session.real
    const generation = session.workerGeneration
    if (runtime) {
      await this.runBoundRuntimeCommand(session, runtime, generation, () => runtime.abort())
      session.projection = runtime.getProjection()
    }
    session.sequence += 1
    session.updatedAt = new Date().toISOString()
    return session
  }

  async setModel(sessionId: string, provider: string, modelId: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    const generation = session.workerGeneration
    if (runtime) {
      await this.runBoundRuntimeCommand(session, runtime, generation, () => runtime.setModel(provider, modelId))
    }
    session.sequence += 1
    session.updatedAt = new Date().toISOString()
    return session
  }

  async setThinkingLevel(sessionId: string, level: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    const generation = session.workerGeneration
    if (runtime) {
      await this.runBoundRuntimeCommand(session, runtime, generation, () => runtime.setThinkingLevel(level))
    }
    session.sequence += 1
    session.updatedAt = new Date().toISOString()
    return session
  }

  async compact(sessionId: string, instructions?: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    const generation = session.workerGeneration
    if (runtime) {
      await this.runBoundRuntimeCommand(session, runtime, generation, () => runtime.compact(instructions))
      session.projection = runtime.getProjection()
    }
    session.sequence += 1
    session.updatedAt = new Date().toISOString()
    return session
  }

  async navigateTree(
    sessionId: string,
    entryId: string,
    summarize = false,
  ): Promise<{ session: AppSession; editorText?: string; cancelled: boolean; aborted?: boolean }> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("tree navigation")
    const generation = session.workerGeneration
    let result!: { editorText?: string; cancelled: boolean; aborted?: boolean }
    await this.runBoundRuntimeCommand(session, runtime, generation, async () => {
      result = await runtime.navigateTree(entryId, summarize)
    })
    session.projection = runtime.getProjection()
    this.touch(session)
    return { session, ...result }
  }

  async setLabel(sessionId: string, entryId: string, label?: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("entry labels")
    await this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => runtime.setLabel(entryId, label))
    this.touch(session)
    return session
  }

  async setSessionName(sessionId: string, name: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const normalized = name.replace(/[\r\n]+/g, " ").trim()
    if (session.real) {
      await this.runBoundRuntimeCommand(
        session,
        session.real,
        session.workerGeneration,
        () => session.real!.setSessionName(normalized),
      )
    }
    session.title = normalized || "New chat"
    this.touch(session)
    return session
  }

  forkSession(
    sessionId: string,
    entryId: string,
    position: "before" | "at",
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    return this.replaceSession(sessionId, runtime => runtime.fork(entryId, position))
  }

  cloneSession(
    sessionId: string,
    entryId?: string,
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    return this.replaceSession(sessionId, runtime => runtime.clone(entryId))
  }

  importSession(
    sessionId: string,
    inputPath: string,
    cwdOverride?: string,
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    return this.replaceSession(sessionId, runtime => runtime.importSession(inputPath, cwdOverride))
  }

  async listSkills(sessionId: string) {
    const session = await this.attach(sessionId)
    return session.real?.listSkills() ?? []
  }

  async listCommands(sessionId: string) {
    const session = await this.attach(sessionId)
    if (session.real) return session.real.listCommands()
    return [
      { name: "new", description: "New session", source: "builtin" as const },
      { name: "compact", description: "Compact (mock no-op)", source: "builtin" as const },
    ]
  }

  private require(sessionId: string): AppSession {
    const session = this.byId.get(sessionId)
    if (!session) {
      throw Object.assign(new Error("session not found"), { code: "SESSION_NOT_FOUND" as const })
    }
    return session
  }

  private touch(session: AppSession): void {
    session.sequence += 1
    session.updatedAt = new Date().toISOString()
  }

  private async replaceSession(
    sessionId: string,
    replace: (runtime: PiSessionRuntime) => Promise<SessionReplacementResultV1>,
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    const source = await this.attach(sessionId)
    const runtime = source.real
    if (!runtime) throw unsupportedRuntimeOperation("session replacement")
    const sourceProjection = source.projection
    const sourceGeneration = source.workerGeneration
    source.nativeEntries = runtime.getEntries()
    source.nativeTree = runtime.getTree()
    source.nativeLeafId = runtime.getLeafId()
    let replacement: SessionReplacementResultV1
    try {
      replacement = await replace(runtime)
    } catch (error) {
      if ((error as { code?: string }).code === "SESSION_REPLACEMENT_COMMIT_FAILED") {
        this.unbindRuntime(source)
        source.real = undefined
        source.workerGeneration = undefined
        this.touch(source)
        await this.disposeRuntime(runtime)
      }
      throw error
    }
    if (replacement.cancelled) return { source, target: source, replacement }
    if (!this.isCurrentRuntime(source, runtime, sourceGeneration)) throw runtimeReplacedError()

    const targetId = replacement.targetSessionId
    try {
      if (!targetId || targetId === source.id) {
        throw Object.assign(new Error("Pi session replacement did not produce a new session"), { code: "INTERNAL" })
      }
      const existingTarget = this.byId.get(targetId)
      if (existingTarget) {
        throw Object.assign(new Error("Replacement target already exists"), { code: "SESSION_BUSY" })
      }
      const targetSessionFile = replacement.targetSessionFile ?? runtime.getSessionFile()
      if (sameSessionFile(source.sessionFile, targetSessionFile)) {
        throw Object.assign(new Error("Replacement target reused the source session file"), {
          code: "SESSION_REPLACEMENT_FILE_CONFLICT",
        })
      }

      this.unbindRuntime(source)
      source.real = undefined
      source.workerGeneration = undefined
      source.projection = sourceProjection
      this.touch(source)

      let workspaceId = source.workspaceId
      if (replacement.targetCwd) workspaceId = this.workspaces.register(replacement.targetCwd).id
      const now = new Date().toISOString()
      const target: AppSession = {
        id: targetId,
        workspaceId,
        driverSessionId: targetId,
        title: runtime.getSessionName() ?? `${source.title} fork`,
        createdAt: now,
        updatedAt: now,
        epoch: randomUUID(),
        sequence: 0,
        projection: runtime.getProjection(),
        driver: "pi",
        sessionFile: targetSessionFile,
      }
      target.workspaceId = workspaceId
      target.sessionFile = targetSessionFile
      target.projection = runtime.getProjection()
      this.byId.set(target.id, target)
      this.bindRuntime(target, runtime)
      return { source, target, replacement }
    } catch (error) {
      if (targetId && this.byId.get(targetId)?.real === runtime) this.byId.delete(targetId)
      this.unbindRuntime(source)
      source.real = undefined
      source.workerGeneration = undefined
      source.projection = sourceProjection
      this.touch(source)
      await this.disposeRuntime(runtime)
      throw error
    }
  }

  async find(sessionId: string): Promise<AppSession | undefined> {
    if (!this.byId.has(sessionId)) await this.discover()
    return this.byId.get(sessionId)
  }

  async attach(sessionId: string): Promise<AppSession> {
    const session = await this.find(sessionId)
    if (!session) {
      throw Object.assign(new Error("session not found"), { code: "SESSION_NOT_FOUND" as const })
    }
    if (session.driver !== "pi" || session.real) return session
    let pending = this.attaching.get(sessionId)
    if (!pending) {
      pending = this.openRealSession(session)
      this.attaching.set(sessionId, pending)
      void pending.then(() => {
        if (this.attaching.get(sessionId) === pending) this.attaching.delete(sessionId)
      }, () => {
        if (this.attaching.get(sessionId) === pending) this.attaching.delete(sessionId)
      })
    }
    const runtime = await pending
    if (this.deleting.has(sessionId) || this.byId.get(sessionId) !== session) {
      try {
        await this.disposeRuntime(runtime)
      } catch {
        /* preserve SESSION_NOT_FOUND after best-effort cleanup */
      }
      throw Object.assign(new Error("session not found"), { code: "SESSION_NOT_FOUND" as const })
    }
    if (!session.real) {
      this.bindRuntime(session, runtime)
    }
    return session
  }

  private async openRealSession(session: AppSession): Promise<PiSessionRuntime> {
    if (this.driver !== "pi") {
      throw Object.assign(new Error("Pi runtime is not enabled"), { code: "DRIVER_UNAVAILABLE" })
    }
    const workspace = this.workspaces.get(session.workspaceId)
    if (!workspace) {
      throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
    }
    const backend = await this.getBackend()
    return backend.open(workspace.canonicalRoot, session.sessionFile)
  }

  private bindRuntime(session: AppSession, runtime: PiSessionRuntime): void {
    this.unbindRuntime(session)
    session.real = runtime
    session.projection = runtime.getProjection()
    session.driverSessionId = runtime.getSessionId()
    session.sessionFile = runtime.getSessionFile() ?? session.sessionFile
    session.title = runtime.getSessionName() ?? session.title
    session.workerGeneration = runtime.getWorkerGeneration?.()
    session.runtimeError = undefined
    session.sequence += 1
    session.updatedAt = new Date().toISOString()

    const generation = session.workerGeneration
    const binding = { runtime, unsubscribe: () => {} }
    this.runtimeBindings.set(session.id, binding)
    if (generation) {
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.runtime.replaced",
        { sessionId: session.id, workerGeneration: generation },
      )
    }
    this.eventHub?.publishV2(
      { kind: "session", id: session.id },
      "session.snapshot.updated",
      { sessionId: session.id, reason: "runtime", snapshot: this.snapshot(session) },
    )
    let initialState = true
    const unsubscribeState = runtime.onState?.(() => {
      if (initialState) {
        initialState = false
        return
      }
      if (!this.isCurrentRuntime(session, runtime, generation)) return
      session.sequence += 1
      session.updatedAt = new Date().toISOString()
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.snapshot.updated",
        { sessionId: session.id, reason: "runtime", snapshot: this.snapshot(session) },
      )
    })
    const unsubscribeCrash = runtime.onCrash?.(error => {
      if (!this.isCurrentRuntime(session, runtime, generation)) return
      this.runtimeBindings.delete(session.id)
      binding.unsubscribe()
      session.real = undefined
      session.runtimeError = error.message
      session.projection = {
        ...session.projection,
        isStreaming: false,
        timeline: session.projection.timeline.map(item =>
          item.type === "assistant" && item.status === "streaming"
            ? { ...item, status: "error", stopReason: item.stopReason ?? "error" }
            : item,
        ),
      }
      session.sequence += 1
      session.updatedAt = new Date().toISOString()
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.runtime.crashed",
        { sessionId: session.id, workerGeneration: generation, message: error.message },
      )
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.snapshot.updated",
        { sessionId: session.id, reason: "runtime", snapshot: this.snapshot(session) },
      )
      this.onRuntimeCrash?.(session.id, generation, error)
    })
    binding.unsubscribe = () => {
      unsubscribeState?.()
      unsubscribeCrash?.()
    }
  }

  private isCurrentRuntime(
    session: AppSession,
    runtime: PiSessionRuntime,
    generation: string | undefined,
  ): boolean {
    return session.real === runtime && session.workerGeneration === generation &&
      this.runtimeBindings.get(session.id)?.runtime === runtime
  }

  private async runBoundRuntimeCommand(
    session: AppSession,
    runtime: PiSessionRuntime,
    generation: string | undefined,
    run: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await run()
    } catch (error) {
      if (!this.isCurrentRuntime(session, runtime, generation)) throw runtimeReplacedError()
      throw error
    }
    if (!this.isCurrentRuntime(session, runtime, generation)) throw runtimeReplacedError()
  }

  private unbindRuntime(session: AppSession): void {
    const binding = this.runtimeBindings.get(session.id)
    if (!binding) return
    this.runtimeBindings.delete(session.id)
    binding.unsubscribe()
  }

  private disposeRuntime(runtime: PiSessionRuntime): Promise<void> {
    const existing = this.runtimeDisposals.get(runtime)
    if (existing) return existing
    const disposing = runtime.dispose()
    this.runtimeDisposals.set(runtime, disposing)
    return disposing
  }

  private async discover(cwd?: string): Promise<void> {
    if (this.driver !== "pi") return
    const allKey = "*"
    const key = cwd ?? allKey
    const now = Date.now()
    const allPending = this.discovering.get(allKey)
    if (allPending) return allPending
    if (cwd && now - (this.discoveredAt.get(allKey) ?? 0) < DISCOVERY_TTL_MS) return
    if (now - (this.discoveredAt.get(key) ?? 0) < DISCOVERY_TTL_MS) return

    const existing = this.discovering.get(key)
    if (existing) return existing

    const pending = this.scanDiscovered(cwd).finally(() => {
      if (this.discovering.get(key) === pending) this.discovering.delete(key)
    })
    this.discovering.set(key, pending)
    return pending
  }

  private async scanDiscovered(cwd?: string): Promise<void> {
    const backend = await this.getBackend()
    const infos = cwd && backend.list ? await backend.list(cwd) : await backend.listAll()
    const seen = new Set(infos.map(info => info.id))
    for (const info of infos) this.addDiscovered(info)

    const workspaceId = cwd ? this.workspaces.register(cwd).id : undefined
    for (const [id, session] of this.byId) {
      if (session.driver !== "pi" || session.real || seen.has(id)) continue
      if (!workspaceId || session.workspaceId === workspaceId) this.byId.delete(id)
    }
    this.discoveredAt.set(cwd ?? "*", Date.now())
  }

  private async getBackend(): Promise<PiSessionBackend> {
    if (this.injectedBackend) return this.injectedBackend
    this.backendPromise ??= import("./runtime-supervisor.ts").then(({ RuntimeSupervisor }) => {
      return new RuntimeSupervisor()
    })
    return this.backendPromise
  }

  private addDiscovered(info: PiSessionInfo): void {
    if (this.hiddenIds.has(info.id) || !info.cwd) return
    let workspaceId: string
    try {
      workspaceId = this.workspaces.register(info.cwd).id
    } catch {
      return
    }
    const existing = this.byId.get(info.id)
    if (existing) {
      if (!existing.real) {
        existing.workspaceId = workspaceId
        existing.title = info.name ?? (info.firstMessage.slice(0, 48) || "New chat")
        existing.createdAt = info.createdAt
        existing.updatedAt = info.updatedAt
        existing.sessionFile = info.path
      }
      return
    }
    this.byId.set(info.id, {
      id: info.id,
      workspaceId,
      driverSessionId: info.id,
      title: info.name ?? (info.firstMessage.slice(0, 48) || "New chat"),
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      epoch: randomUUID(),
      sequence: 0,
      projection: createProjectionState(),
      driver: "pi",
      sessionFile: info.path,
    })
  }

  async dispose(): Promise<void> {
    for (const session of this.byId.values()) this.unbindRuntime(session)
    await Promise.all([
      ...[...this.byId.values()].map(async session => {
        try {
          if (session.real) await this.disposeRuntime(session.real)
        } catch {
          /* best effort while the HTTP server is closing */
        }
      }),
      (async () => {
        try {
          const backend = this.injectedBackend ?? (this.backendPromise ? await this.backendPromise : undefined)
          await backend?.dispose?.()
        } catch {
          /* best effort while the HTTP server is closing */
        }
      })(),
    ])
  }

  snapshot(session: AppSession): SessionSnapshotV1 {
    const ui = session.real?.getRuntimeUiState()
    const model = ui?.model ?? session.real?.getModel()
    const isStreaming = !session.runtimeError &&
      Boolean(ui?.isStreaming || session.projection.isStreaming || session.real?.isStreaming())
    const isCompacting = !session.runtimeError && (ui?.isCompacting ?? false)
    let state: SessionSnapshotV1["session"]["state"] = "idle"
    if (session.runtimeError) state = "crashed"
    else if (isCompacting) state = "compacting"
    else if (ui?.retryAttempt) state = "retrying"
    else if (isStreaming) state = "running"

    return {
      protocolVersion: 1,
      epoch: session.epoch,
      sequence: session.sequence,
      session: {
        id: session.id,
        workspaceId: session.workspaceId,
        driverId: "pi",
        driverSessionId: session.driverSessionId,
        title: session.title,
        state,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      runtime: {
        attached: session.driver === "mock" || Boolean(session.real),
        model: model
          ? { provider: model.provider, id: model.id, displayName: model.displayName }
          : session.driver === "mock"
            ? { provider: "mock", id: "mock", displayName: "Mock" }
            : undefined,
        thinkingLevel: ui?.thinkingLevel ?? session.real?.getThinkingLevel() ?? "off",
        availableThinkingLevels:
          ui?.availableThinkingLevels ??
          (session.real
            ? session.real.getAvailableThinkingLevels()
            : ["off", "minimal", "low", "medium", "high"]),
        isStreaming,
        isCompacting,
        queue: ui?.queue ?? { steering: [], followUp: [] },
        activeTools: ui?.activeTools?.length
          ? ui.activeTools
          : ["read", "bash", "edit", "write", "grep", "find", "ls"],
        workerGeneration: session.workerGeneration,
        runtimeError: session.runtimeError,
      },
      timeline: session.projection.timeline as TimelineItemV1[],
      native: {
        namespace: "pi",
        schemaVersion: 1,
        leafId: session.real?.getLeafId() ?? session.nativeLeafId ?? session.projection.timeline.at(-1)?.entryId ?? null,
        entries: session.real?.getEntries() ?? session.nativeEntries ?? [],
        tree: session.real?.getTree() ?? session.nativeTree ?? [],
      },
    }
  }
}

function runtimeReplacedError(): Error {
  return Object.assign(new Error("Pi runtime was replaced before the command completed"), {
    code: "SESSION_RUNTIME_CRASHED",
  })
}

function unsupportedRuntimeOperation(operation: string): Error {
  return Object.assign(new Error(`Pi runtime does not support ${operation}`), { code: "CAPABILITY_DISABLED" })
}

function sameSessionFile(sourceFile?: string, targetFile?: string): boolean {
  if (!sourceFile || !targetFile) return false
  const sourcePath = path.resolve(sourceFile)
  const targetPath = path.resolve(targetFile)
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
  if (normalize(sourcePath) === normalize(targetPath)) return true
  try {
    if (normalize(realpathSync.native(sourcePath)) === normalize(realpathSync.native(targetPath))) return true
    const sourceStats = statSync(sourcePath, { bigint: true })
    const targetStats = statSync(targetPath, { bigint: true })
    return sourceStats.ino !== 0n && sourceStats.dev === targetStats.dev && sourceStats.ino === targetStats.ino
  } catch {
    return false
  }
}
