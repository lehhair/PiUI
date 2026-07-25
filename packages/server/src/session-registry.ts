import { randomUUID } from "node:crypto"
import type { SessionSnapshotV1, TimelineItemV1 } from "@piui/protocol"
import {
  applyWorkerEvent,
  createProjectionState,
  getDriverMode,
  loadRealPiSession,
  runMockTurn,
  type DriverMode,
  type PiSessionInfo,
  type ProjectionState,
  type RealPiSession,
} from "@piui/pi-worker"
import type { WorkspaceStore } from "./workspace-store.ts"

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
  real?: RealPiSession
}

export interface PiSessionBackend {
  listAll(): Promise<PiSessionInfo[]>
  open(cwd: string, sessionFile?: string): Promise<RealPiSession>
}

export class SessionRegistry {
  private readonly byId = new Map<string, AppSession>()
  private readonly attaching = new Map<string, Promise<RealPiSession>>()
  private readonly hiddenIds = new Set<string>()
  private readonly driver: DriverMode

  constructor(
    private readonly workspaces: WorkspaceStore,
    driver: DriverMode = getDriverMode(),
    private readonly injectedBackend?: PiSessionBackend,
  ) {
    this.driver = driver
  }

  getDriver(): DriverMode {
    return this.driver
  }

  async list(workspaceId?: string): Promise<AppSession[]> {
    await this.discover()
    const all = [...this.byId.values()]
    return workspaceId ? all.filter(s => s.workspaceId === workspaceId) : all
  }

  get(id: string): AppSession | undefined {
    return this.byId.get(id)
  }

  async delete(id: string): Promise<boolean> {
    const s = this.byId.get(id)
    if (!s) return false
    if (s.real) {
      try {
        await s.real.dispose()
      } catch {
        /* ignore */
      }
    }
    this.hiddenIds.add(id)
    return this.byId.delete(id)
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
    let real: RealPiSession | undefined
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
      real,
    }
    this.byId.set(session.id, session)
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
      try {
        if (opts?.model?.provider && opts.model.id) {
          await session.real.setModel(opts.model.provider, opts.model.id)
        }
        await session.real.prompt(
          trimmed,
          projection => {
            session.projection = projection
            session.sequence += 1
            session.updatedAt = new Date().toISOString()
            opts?.onTick?.(session)
          },
          { deliverAs: opts?.deliverAs },
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw Object.assign(new Error(msg), { code: "INTERNAL" as const })
      }
      session.projection = session.real.getProjection()
      session.sessionFile = session.real.getSessionFile() ?? session.sessionFile
      session.title = session.real.getSessionName() ?? session.title
      if (session.title === "New chat" || session.title === "Mock session" || session.title === "Mock chat") {
        session.title = trimmed.slice(0, 48)
      }
      session.updatedAt = new Date().toISOString()
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
    session.updatedAt = new Date().toISOString()
    return session
  }

  async abort(sessionId: string): Promise<AppSession | undefined> {
    const session = await this.find(sessionId)
    if (!session) return undefined
    await this.attach(sessionId)
    if (session.real) {
      await session.real.abort()
      session.projection = session.real.getProjection()
    }
    session.updatedAt = new Date().toISOString()
    return session
  }

  async setModel(sessionId: string, provider: string, modelId: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    if (session.real) {
      await session.real.setModel(provider, modelId)
    }
    session.updatedAt = new Date().toISOString()
    return session
  }

  async setThinkingLevel(sessionId: string, level: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    if (session.real) {
      session.real.setThinkingLevel(level)
    }
    session.updatedAt = new Date().toISOString()
    return session
  }

  async compact(sessionId: string, instructions?: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    if (session.real) {
      await session.real.compact(instructions)
      session.projection = session.real.getProjection()
    }
    session.updatedAt = new Date().toISOString()
    return session
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
    session.real = await pending
    session.projection = session.real.getProjection()
    session.driverSessionId = session.real.getSessionId()
    session.sessionFile = session.real.getSessionFile() ?? session.sessionFile
    session.title = session.real.getSessionName() ?? session.title
    return session
  }

  private async openRealSession(session: AppSession): Promise<RealPiSession> {
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

  private async discover(): Promise<void> {
    if (this.driver !== "pi") return
    const backend = await this.getBackend()
    const infos = await backend.listAll()
    for (const info of infos) this.addDiscovered(info)
  }

  private async getBackend(): Promise<PiSessionBackend> {
    if (this.injectedBackend) return this.injectedBackend
    const RealPiSession = await loadRealPiSession()
    return {
      listAll: () => RealPiSession.listAll(),
      open: (cwd, sessionFile) => RealPiSession.open(cwd, sessionFile),
    }
  }

  private addDiscovered(info: PiSessionInfo): void {
    if (this.byId.has(info.id) || this.hiddenIds.has(info.id) || !info.cwd) return
    let workspaceId: string
    try {
      workspaceId = this.workspaces.register(info.cwd).id
    } catch {
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

  snapshot(session: AppSession): SessionSnapshotV1 {
    const ui = session.real?.getRuntimeUiState()
    const model = ui?.model ?? session.real?.getModel()
    const isStreaming =
      ui?.isStreaming || session.projection.isStreaming || Boolean(session.real?.isStreaming())
    const isCompacting = ui?.isCompacting ?? false
    let state: SessionSnapshotV1["session"]["state"] = "idle"
    if (isCompacting) state = "compacting"
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
      },
      timeline: session.projection.timeline as TimelineItemV1[],
      native: {
        namespace: "pi",
        schemaVersion: 1,
        leafId: session.real?.getLeafId() ?? session.projection.timeline.at(-1)?.entryId ?? null,
        entries: session.real?.getEntries() ?? [],
        tree: session.real?.getTree() ?? [],
      },
    }
  }
}
