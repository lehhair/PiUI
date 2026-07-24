import { randomUUID } from "node:crypto"
import type { SessionSnapshotV1, TimelineItemV1 } from "@piui/protocol"
import {
  applyWorkerEvent,
  createProjectionState,
  runMockTurn,
  type ProjectionState,
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
}

export class SessionRegistry {
  private readonly byId = new Map<string, AppSession>()

  constructor(private readonly workspaces: WorkspaceStore) {}

  list(workspaceId?: string): AppSession[] {
    const all = [...this.byId.values()]
    return workspaceId ? all.filter(s => s.workspaceId === workspaceId) : all
  }

  get(id: string): AppSession | undefined {
    return this.byId.get(id)
  }

  /** Create session and optionally seed with deterministic mock turn (no LLM). */
  create(workspaceId: string, opts?: { title?: string; seedMock?: boolean }): AppSession {
    if (!this.workspaces.get(workspaceId)) {
      throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" as const })
    }
    const now = new Date().toISOString()
    let projection = createProjectionState()
    let sequence = 0
    if (opts?.seedMock !== false) {
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
    const session: AppSession = {
      id: randomUUID(),
      workspaceId,
      driverSessionId: `mock-${randomUUID().slice(0, 8)}`,
      title: opts?.title ?? "Mock session",
      createdAt: now,
      updatedAt: now,
      epoch: randomUUID(),
      sequence,
      projection,
    }
    this.byId.set(session.id, session)
    return session
  }

  snapshot(session: AppSession): SessionSnapshotV1 {
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
        state: session.projection.isStreaming ? "running" : "idle",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      runtime: {
        attached: true,
        model: { provider: "mock", id: "mock", displayName: "Mock" },
        thinkingLevel: "off",
        availableThinkingLevels: ["off", "low", "medium", "high"],
        isStreaming: session.projection.isStreaming,
        isCompacting: false,
        queue: { steering: [], followUp: [] },
        activeTools: ["read", "bash", "edit"],
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
