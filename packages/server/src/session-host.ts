import type { CommandEnvelope, CommandRecord, JsonObject, JsonValue } from "@piui/protocol"
import { isJsonObject } from "@piui/protocol"
import type { WorkerEvent } from "@piui/pi-worker"
import type { EventHub } from "./event-hub.ts"
import type { RuntimeSupervisor } from "./runtime-supervisor.ts"
import { SessionExecutor, type SubmittedCommand } from "./session-executor.ts"
import type { WorkerSession } from "./worker-client.ts"

export interface AttachedSession {
  sessionId: string
  cwd: string
  sessionFile?: string
  worker: WorkerSession
}

const SESSION_QUERY_COMMANDS = new Set([
  "state.get",
  "entries.get",
  "branch.get",
  "tree.get",
  "registry.get",
  "attachment.get",
])

export class SessionHost {
  private readonly attached = new Map<string, AttachedSession>()
  readonly executor: SessionExecutor

  constructor(
    private readonly supervisor: RuntimeSupervisor,
    private readonly hub: EventHub,
  ) {
    this.executor = new SessionExecutor(record => this.emitCommandUpdate(record))
    this.supervisor.onEvent(event => this.routeCatalogEvent(event))
  }

  async openSession(cwd: string, sessionFile?: string): Promise<JsonObject> {
    const worker = await this.supervisor.open(cwd, sessionFile)
    const session: AttachedSession = {
      sessionId: worker.getSessionId(),
      cwd: worker.getCwd() || cwd,
      sessionFile: worker.getSessionFile() ?? sessionFile,
      worker,
    }
    this.attach(session)
    const state = await worker.command("state.get") as JsonObject | undefined
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? null,
      cwd: session.cwd,
      state: state ?? null,
    }
  }

  private attach(session: AttachedSession): void {
    this.attached.set(session.sessionId, session)
    session.worker.onEvent(event => this.routeSessionEvent(session, event))
    session.worker.onCrash(() => {
      this.executor.markRuntimeCrashed(session.sessionId)
      this.attached.delete(session.sessionId)
      this.hub.publish({ kind: "session", id: session.sessionId }, "sessions.updated", {
        sessionId: session.sessionId,
        crashed: true,
      })
    })
    session.worker.onClose(() => {
      this.attached.delete(session.sessionId)
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
    const session = this.attached.get(sessionId)
    if (!session) throw Object.assign(new Error("session is not attached"), { code: "SESSION_NOT_FOUND" })
    this.attached.delete(sessionId)
    await session.worker.dispose()
    this.hub.publish({ kind: "server", id: "server" }, "sessions.updated", {
      sessionId,
      detached: true,
    })
  }

  getAttached(sessionId: string): AttachedSession | undefined {
    return this.attached.get(sessionId)
  }

  listAttachedIds(): string[] {
    return [...this.attached.keys()]
  }

  requireAttached(sessionId: string): AttachedSession {
    const session = this.attached.get(sessionId)
    if (!session) {
      throw Object.assign(new Error("session is not attached"), { code: "SESSION_NOT_FOUND" })
    }
    return session
  }

  async sessionQuery(sessionId: string, type: string, params?: JsonObject): Promise<JsonValue | undefined> {
    const session = this.requireAttached(sessionId)
    if (!SESSION_QUERY_COMMANDS.has(type)) {
      throw Object.assign(new Error(`${type} is not a query command`), { code: "INVALID_REQUEST" })
    }
    return session.worker.command(type, params)
  }

  submitSessionCommand(sessionId: string, envelope: Omit<CommandEnvelope, "sessionId">): SubmittedCommand {
    const session = this.requireAttached(sessionId)
    const full: CommandEnvelope = { ...envelope, sessionId }
    return this.executor.submit(full, async () => {
      const data = await session.worker.command(full.type, full.params)
      this.trackReplacement(session, data)
      return data
    })
  }

  getCommand(commandId: string): CommandRecord | undefined {
    return this.executor.get(commandId)
  }

  async catalogCommand(type: string, params?: JsonObject, options?: { retry?: boolean }): Promise<JsonValue | undefined> {
    return this.supervisor.catalogCommand(type, params, options)
  }

  private trackReplacement(session: AttachedSession, data: JsonValue | undefined): void {
    if (!isJsonObject(data) || data.cancelled !== false || typeof data.targetSessionId !== "string") return
    if (data.targetSessionId === session.sessionId) return
    this.attached.delete(session.sessionId)
    session.sessionId = data.targetSessionId
    session.sessionFile = typeof data.targetSessionFile === "string" ? data.targetSessionFile : session.sessionFile
    session.cwd = typeof data.targetCwd === "string" ? data.targetCwd : session.cwd
    this.attached.set(session.sessionId, session)
    this.hub.publish({ kind: "server", id: "server" }, "sessions.updated", {
      replaced: true,
      sourceSessionId: typeof data.sourceSessionId === "string" ? data.sourceSessionId : undefined,
      targetSessionId: session.sessionId,
      targetSessionFile: session.sessionFile,
      targetCwd: session.cwd,
    })
  }

  private routeSessionEvent(session: AttachedSession, event: WorkerEvent): void {
    if (event.channel === "pi.event") {
      this.hub.publish({ kind: "session", id: session.sessionId }, "pi.event", {
        event: event.event,
        meta: event.meta,
      })
      return
    }
    if (event.channel === "session.head") {
      this.hub.publish({ kind: "session", id: session.sessionId }, "session.head", event.head)
      return
    }
    if (event.channel === "extension.ui") {
      this.hub.publish({ kind: "session", id: session.sessionId }, "extension.ui", event.event)
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

  private emitCommandUpdate(record: CommandRecord): void {
    const stream = record.sessionId
      ? { kind: "session" as const, id: record.sessionId }
      : { kind: "server" as const, id: "server" }
    this.hub.publish(stream, "command.updated", record as unknown as JsonValue)
  }
}
