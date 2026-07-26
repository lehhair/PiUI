import { createHash } from "node:crypto"
import type {
  CommandRecordV2,
  CommandRequestV2,
  CommandStatusV2,
  CommandTypeV2,
} from "@piui/protocol"

/** Retained finished commands, enough for idempotent client retries. */
const MAX_RETAINED_COMMANDS = 512

interface CommandEntry {
  record: CommandRecordV2
  promise: Promise<unknown>
  requestFingerprint: string
}

export interface SubmittedCommand<T, C extends CommandTypeV2 = CommandTypeV2> {
  record: CommandRecordV2<C>
  promise: Promise<T>
  reused: boolean
}

export interface SubmitCommandOptions<T, C extends CommandTypeV2> {
  recordResult?: (result: T) => unknown
  recordRequest?: (request: CommandRequestV2<C>) => CommandRequestV2<C>
}

export class SessionExecutor {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly commands = new Map<string, CommandEntry>()
  private readonly crashEpochs = new Map<string, number>()

  constructor(private readonly onUpdate?: (record: CommandRecordV2) => void) {}

  submit<T, C extends CommandTypeV2>(
    request: CommandRequestV2<C>,
    run: () => Promise<T>,
    options?: SubmitCommandOptions<T, C>,
  ): SubmittedCommand<T, C> {
    // Hashed so retained entries never hold attachment payloads.
    const requestFingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex")
    const existing = this.commands.get(request.commandId)
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw Object.assign(new Error("commandId already used for another command"), {
          code: "COMMAND_ALREADY_ACCEPTED",
        })
      }
      return {
        record: existing.record as CommandRecordV2<C>,
        promise: existing.promise as Promise<T>,
        reused: true,
      }
    }

    const record: CommandRecordV2<C> = {
      request: options?.recordRequest?.(request) ?? request,
      status: "accepted",
      submittedAt: new Date().toISOString(),
    }
    const laneId = commandLane(request)
    const crashEpoch = request.sessionId ? (this.crashEpochs.get(request.sessionId) ?? 0) : 0
    const previous = laneId ? (this.tails.get(laneId) ?? Promise.resolve()) : Promise.resolve()
    const promise = previous
      .catch(() => undefined)
      .then(async () => {
        if (
          record.status === "cancelled" ||
          (request.sessionId && (this.crashEpochs.get(request.sessionId) ?? 0) !== crashEpoch)
        ) {
          throw runtimeCrashError()
        }
        record.status = "running"
        record.startedAt = new Date().toISOString()
        this.emit(record)
        try {
          const result = await run()
          if ((record as CommandRecordV2).status === "unknown_after_crash") throw runtimeCrashError()
          record.status = "completed"
          if (options?.recordResult) record.result = options.recordResult(result)
          record.completedAt = new Date().toISOString()
          this.emit(record)
          return result
        } catch (error) {
          if (!isCrashTerminalStatus(record.status)) {
            record.status = "failed"
            record.completedAt = new Date().toISOString()
            record.error = {
              code: error && typeof error === "object" && "code" in error ? String(error.code) : "INTERNAL",
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
    this.commands.set(request.commandId, { record, promise, requestFingerprint })
    this.pruneFinishedCommands()
    this.emit(record)
    return { record, promise, reused: false }
  }

  /** Drops the oldest settled commands so a long-lived server cannot grow without bound. */
  private pruneFinishedCommands(): void {
    if (this.commands.size <= MAX_RETAINED_COMMANDS) return
    for (const [commandId, entry] of this.commands) {
      if (this.commands.size <= MAX_RETAINED_COMMANDS) return
      if (entry.record.status === "accepted" || entry.record.status === "running") continue
      this.commands.delete(commandId)
    }
  }

  get(commandId: string): CommandRecordV2 | undefined {
    return this.commands.get(commandId)?.record
  }

  markRuntimeCrashed(sessionId: string): void {
    this.crashEpochs.set(sessionId, (this.crashEpochs.get(sessionId) ?? 0) + 1)
    for (const { record } of this.commands.values()) {
      if (record.request.sessionId !== sessionId) continue
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

  private emit(record: CommandRecordV2): void {
    this.onUpdate?.({
      ...record,
      request: { ...record.request, payload: { ...record.request.payload } },
      error: record.error ? { ...record.error } : undefined,
      result: record.result,
    })
  }
}

function runtimeCrashError(): Error {
  return Object.assign(new Error("Pi worker crashed before command completion could be confirmed"), {
    code: "SESSION_RUNTIME_CRASHED",
  })
}

function isCrashTerminalStatus(status: CommandStatusV2): boolean {
  return status === "unknown_after_crash" || status === "cancelled"
}

function commandLane(request: CommandRequestV2): string | undefined {
  if (request.concurrency === "query") return undefined
  if (!request.sessionId) {
    throw Object.assign(new Error(`${request.type} requires sessionId`), { code: "INVALID_REQUEST" })
  }
  return request.concurrency === "run-control"
    ? `control:${request.sessionId}`
    : `session:${request.sessionId}`
}
