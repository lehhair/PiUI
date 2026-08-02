import { createHash } from "node:crypto"
import type { CommandEnvelope, CommandRecord, CommandStatus, JsonValue } from "@piui/protocol"

const MAX_RETAINED_COMMANDS = 512

interface CommandEntry {
  record: CommandRecord
  promise: Promise<JsonValue | undefined>
  requestFingerprint: string
}

export interface SubmittedCommand {
  record: CommandRecord
  promise: Promise<JsonValue | undefined>
  reused: boolean
}

export class SessionExecutor {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly commands = new Map<string, CommandEntry>()
  private readonly crashEpochs = new Map<string, number>()
  private readonly closing = new Set<string>()
  private readonly closed = new Set<string>()
  private readonly closeFlights = new Map<string, Promise<void>>()

  constructor(private readonly onUpdate?: (record: CommandRecord) => void) {}

  submit(
    envelope: CommandEnvelope,
    run: () => Promise<JsonValue | undefined>,
  ): SubmittedCommand {
    if (envelope.sessionId && (this.closing.has(envelope.sessionId) || this.closed.has(envelope.sessionId))) {
      throw Object.assign(new Error("session runtime is closing"), { code: "RUNTIME_CLOSING" })
    }
    const requestFingerprint = createHash("sha256").update(JSON.stringify(envelope)).digest("hex")
    const existing = this.commands.get(envelope.id)
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw Object.assign(new Error("command id already used for another command"), {
          code: "COMMAND_ALREADY_ACCEPTED",
        })
      }
      return { record: existing.record, promise: existing.promise, reused: true }
    }

    const record: CommandRecord = {
      id: envelope.id,
      type: envelope.type,
      sessionId: envelope.sessionId,
      status: "accepted",
      submittedAt: new Date().toISOString(),
    }
    const laneId = envelope.sessionId ? `session:${envelope.sessionId}` : undefined
    const crashEpoch = envelope.sessionId ? (this.crashEpochs.get(envelope.sessionId) ?? 0) : 0
    const previous = laneId ? (this.tails.get(laneId) ?? Promise.resolve()) : Promise.resolve()
    const promise = previous
      .catch(() => undefined)
      .then(async () => {
        if (
          record.status === "cancelled" ||
          (envelope.sessionId && (this.crashEpochs.get(envelope.sessionId) ?? 0) !== crashEpoch)
        ) {
          throw record.error?.code === "RUNTIME_CLOSING" ? runtimeClosingError() : runtimeCrashError()
        }
        record.status = "running"
        record.startedAt = new Date().toISOString()
        this.emit(record)
        try {
          const result = await run()
          if ((record as CommandRecord).status === "unknown_after_crash") throw runtimeCrashError()
          record.status = "completed"
          record.result = result
          record.completedAt = new Date().toISOString()
          this.emit(record)
          return result
        } catch (error) {
          if (!isCrashTerminalStatus(record.status)) {
            record.status = "failed"
            record.completedAt = new Date().toISOString()
            record.error = {
              code: error && typeof error === "object" && "code" in error
                ? String(error.code) as NonNullable<CommandRecord["error"]>["code"]
                : "INTERNAL",
              message: error instanceof Error ? error.message : String(error),
            }
            this.emit(record)
          }
          throw error
        }
      })

    if (laneId) {
      const tail = promise.then(() => undefined, () => undefined)
      this.tails.set(laneId, tail)
      tail.finally(() => {
        if (this.tails.get(laneId) === tail) this.tails.delete(laneId)
      })
    }
    this.commands.set(envelope.id, { record, promise, requestFingerprint })
    this.pruneFinishedCommands()
    this.emit(record)
    return { record, promise, reused: false }
  }

  private pruneFinishedCommands(): void {
    if (this.commands.size <= MAX_RETAINED_COMMANDS) return
    for (const [commandId, entry] of this.commands) {
      if (this.commands.size <= MAX_RETAINED_COMMANDS) return
      if (entry.record.status === "accepted" || entry.record.status === "running") continue
      this.commands.delete(commandId)
    }
  }

  get(commandId: string): CommandRecord | undefined {
    return this.commands.get(commandId)?.record
  }

  markRuntimeCrashed(sessionId: string): void {
    this.crashEpochs.set(sessionId, (this.crashEpochs.get(sessionId) ?? 0) + 1)
    for (const { record } of this.commands.values()) {
      if (record.sessionId !== sessionId) continue
      if (record.status === "running") {
        record.status = "unknown_after_crash"
      } else if (record.status === "accepted") {
        record.status = "cancelled"
      } else {
        continue
      }
      record.completedAt = new Date().toISOString()
      record.error = {
        code: "SESSION_RUNTIME_CRASHED",
        message: "Pi worker crashed before command completion could be confirmed",
        retryable: true,
      }
      this.emit(record)
    }
  }

  isClosing(sessionId: string): boolean {
    return this.closing.has(sessionId) || this.closed.has(sessionId)
  }

  close(sessionId: string, options: {
    interrupt?: () => Promise<void>
    dispose: () => Promise<void>
  }): Promise<void> {
    const existing = this.closeFlights.get(sessionId)
    if (existing) return existing
    if (this.closed.has(sessionId)) return Promise.resolve()

    this.closing.add(sessionId)
    for (const entry of this.commands.values()) {
      if (entry.record.sessionId !== sessionId || entry.record.status !== "accepted") continue
      entry.record.status = "cancelled"
      entry.record.completedAt = new Date().toISOString()
      entry.record.error = {
        code: "RUNTIME_CLOSING",
        message: "Session runtime is closing",
      }
      this.emit(entry.record)
    }

    const lane = `session:${sessionId}`
    const previous = this.tails.get(lane) ?? Promise.resolve()
    const flight = Promise.resolve()
      .then(() => options.interrupt?.())
      .catch(() => undefined)
      .then(() => previous)
      .catch(() => undefined)
      .then(() => options.dispose())
      .finally(() => {
        this.closing.delete(sessionId)
        this.closed.add(sessionId)
        this.closeFlights.delete(sessionId)
        if (this.tails.get(lane) === flight) this.tails.delete(lane)
      })
    this.closeFlights.set(sessionId, flight)
    this.tails.set(lane, flight)
    return flight
  }

  private emit(record: CommandRecord): void {
    this.onUpdate?.({
      ...record,
      error: record.error ? { ...record.error } : undefined,
    })
  }
}

function runtimeCrashError(): Error {
  return Object.assign(new Error("Pi worker crashed before command completion could be confirmed"), {
    code: "SESSION_RUNTIME_CRASHED",
  })
}

function runtimeClosingError(): Error {
  return Object.assign(new Error("Session runtime is closing"), { code: "RUNTIME_CLOSING" })
}

function isCrashTerminalStatus(status: CommandStatus): boolean {
  return status === "unknown_after_crash" || status === "cancelled"
}
