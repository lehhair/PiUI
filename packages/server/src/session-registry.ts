import { randomUUID } from "node:crypto"
import type { SessionSnapshotV1, TimelineItemV1 } from "@piui/protocol"
import {
  applyWorkerEvent,
  createProjectionState,
  getDriverMode,
  loadRealPiSession,
  runMockTurn,
  type DriverMode,
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
  real?: RealPiSession
}

export class SessionRegistry {
  private readonly byId = new Map<string, AppSession>()
  private readonly driver: DriverMode

  constructor(
    private readonly workspaces: WorkspaceStore,
    driver: DriverMode = getDriverMode(),
  ) {
    this.driver = driver
  }

  getDriver(): DriverMode {
    return this.driver
  }

  list(workspaceId?: string): AppSession[] {
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
      const RealPiSession = await loadRealPiSession()
      real = await RealPiSession.open(ws.canonicalRoot)
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
      id: randomUUID(),
      workspaceId,
      driverSessionId,
      title: opts?.title ?? (seedMock ? "Mock session" : "New chat"),
      createdAt: now,
      updatedAt: now,
      epoch: randomUUID(),
      sequence,
      projection,
      driver: this.driver,
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
    },
  ): Promise<AppSession> {
    const session = this.byId.get(sessionId)
    if (!session) {
      throw Object.assign(new Error("session not found"), { code: "SESSION_NOT_FOUND" as const })
    }
    const trimmed = text.trim()
    if (!trimmed) {
      throw Object.assign(new Error("empty prompt"), { code: "INVALID_REQUEST" as const })
    }

    if (session.real) {
      try {
        if (opts?.model?.provider && opts.model.id) {
          await session.real.setModel(opts.model.provider, opts.model.id)
        }
        await session.real.prompt(trimmed, projection => {
          session.projection = projection
          session.sequence += 1
          session.updatedAt = new Date().toISOString()
          opts?.onTick?.(session)
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw Object.assign(new Error(msg), { code: "INTERNAL" as const })
      }
      session.projection = session.real.getProjection()
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
    const session = this.byId.get(sessionId)
    if (!session) return undefined
    if (session.real) {
      await session.real.abort()
      session.projection = session.real.getProjection()
    }
    session.updatedAt = new Date().toISOString()
    return session
  }

  snapshot(session: AppSession): SessionSnapshotV1 {
    const model = session.real?.getModel()
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
        state: session.projection.isStreaming || session.real?.isStreaming() ? "running" : "idle",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      runtime: {
        attached: true,
        model: model
          ? { provider: model.provider, id: model.id, displayName: model.displayName }
          : session.driver === "mock"
            ? { provider: "mock", id: "mock", displayName: "Mock" }
            : undefined,
        thinkingLevel: session.real?.getThinkingLevel() ?? "off",
        availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        isStreaming: session.projection.isStreaming || Boolean(session.real?.isStreaming()),
        isCompacting: false,
        queue: { steering: [], followUp: [] },
        activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      },
      timeline: session.projection.timeline as TimelineItemV1[],
      native: {
        namespace: "pi",
        schemaVersion: 1,
        leafId: session.projection.timeline.at(-1)?.id ?? null,
        entries: [],
        tree: [],
      },
    }
  }
}
