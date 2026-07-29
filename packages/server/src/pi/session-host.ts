import { randomUUID } from "node:crypto"
import type { CommandEnvelope, CommandRecord, JsonObject, JsonValue, PiCapability, PiRegistrySnapshot } from "@piui/protocol"
import { isJsonObject } from "@piui/protocol"
import { getCommandCapability, type WorkerEvent } from "@piui/pi-worker"
import type { EventHub } from "../event-hub.ts"
import type { RuntimeSupervisor } from "./supervisor.ts"
import { SessionExecutor, type SubmittedCommand } from "./session-executor.ts"
import type { WorkerSession } from "./worker-client.ts"

export interface AttachedSession {
  sessionId: string
  cwd: string
  sessionFile?: string
  worker: WorkerSession
}

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
      properties: { cwd: { type: "string" }, sessionFile: { type: "string" } },
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
    const capability = this.getSessionCapability(type)
    if (capability?.queue !== "immediate") {
      throw Object.assign(new Error(`${type} is not a query command`), { code: "INVALID_REQUEST" })
    }
    return session.worker.command(type, params)
  }

  async piRegistry(): Promise<PiRegistrySnapshot> {
    const data = await this.catalogCommand("registry.describe", undefined, { retry: true }) as PiRegistrySnapshot | undefined
    if (!data || typeof data !== "object") {
      throw Object.assign(new Error("Pi registry is unavailable"), { code: "REGISTRY_UNAVAILABLE" })
    }
    return {
      ...data,
      globalCommands: mergeCapabilities(SERVER_GLOBAL_CAPABILITIES, data.globalCommands),
      sessionCommands: mergeCapabilities(SERVER_SESSION_CAPABILITIES, data.sessionCommands),
    }
  }

  async executeGlobalCommand(type: string, params?: JsonObject): Promise<JsonValue | undefined> {
    if (type === "session.open") {
      const cwd = typeof params?.cwd === "string" ? params.cwd : undefined
      if (!cwd) throw Object.assign(new Error("params.cwd must be a non-empty string"), { code: "INVALID_REQUEST" })
      const sessionFile = typeof params?.sessionFile === "string" ? params.sessionFile : undefined
      return this.openSession(cwd, sessionFile)
    }
    if (type === "session.attached") return this.listAttachedIds()
    return this.catalogCommand(type, params, { retry: true })
  }

  executeSessionCommand(sessionId: string, type: string, params?: JsonObject, id?: string): JsonValue | SubmittedCommand | Promise<JsonValue | undefined> {
    if (type === "session.close") {
      return this.closeSession(sessionId).then(() => ({ ok: true }))
    }
    const capability = this.getSessionCapability(type)
    if (!capability) throw Object.assign(new Error(`unknown command: ${type}`), { code: "UNKNOWN_COMMAND" })
    if (capability.queue === "immediate") return this.sessionQuery(sessionId, type, params)
    return this.submitSessionCommand(sessionId, { id: id ?? randomUUID(), type, params })
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

  private getSessionCapability(type: string): PiCapability | undefined {
    return SERVER_SESSION_CAPABILITIES.find(capability => capability.name === type) ?? getCommandCapability(type)
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
