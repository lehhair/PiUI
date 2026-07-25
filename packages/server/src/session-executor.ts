import type { CommandRecordV1 } from "@piui/protocol"

interface CommandEntry {
  record: CommandRecordV1
  promise: Promise<unknown>
}

export interface SubmittedCommand<T> {
  record: CommandRecordV1
  promise: Promise<T>
  reused: boolean
}

export class SessionExecutor {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly commands = new Map<string, CommandEntry>()

  constructor(private readonly onUpdate?: (record: CommandRecordV1) => void) {}

  private emit(record: CommandRecordV1) {
    this.onUpdate?.({ ...record, error: record.error ? { ...record.error } : undefined })
  }

  submit<T>(sessionId: string, commandId: string, kind: string, run: () => Promise<T>): SubmittedCommand<T> {
    return this.enqueue(sessionId, sessionId, commandId, kind, run)
  }

  submitControl<T>(sessionId: string, commandId: string, kind: string, run: () => Promise<T>): SubmittedCommand<T> {
    return this.enqueue(sessionId, `control:${sessionId}`, commandId, kind, run)
  }

  private enqueue<T>(
    sessionId: string,
    laneId: string,
    commandId: string,
    kind: string,
    run: () => Promise<T>,
  ): SubmittedCommand<T> {
    const existing = this.commands.get(commandId)
    if (existing) {
      if (existing.record.sessionId !== sessionId || existing.record.kind !== kind) {
        throw Object.assign(new Error("commandId already used for another command"), { code: "COMMAND_CONFLICT" })
      }
      return { record: existing.record, promise: existing.promise as Promise<T>, reused: true }
    }

    const record: CommandRecordV1 = {
      commandId,
      sessionId,
      kind,
      status: "accepted",
      submittedAt: new Date().toISOString(),
    }
    const previous = this.tails.get(laneId) ?? Promise.resolve()
    const promise = previous
      .catch(() => undefined)
      .then(async () => {
        record.status = "running"
        record.startedAt = new Date().toISOString()
        this.emit(record)
        try {
          const result = await run()
          record.status = "completed"
          record.completedAt = new Date().toISOString()
          this.emit(record)
          return result
        } catch (error) {
          record.status = "failed"
          record.completedAt = new Date().toISOString()
          record.error = {
            code: error && typeof error === "object" && "code" in error ? String(error.code) : "INTERNAL",
            message: error instanceof Error ? error.message : String(error),
          }
          this.emit(record)
          throw error
        }
      })
    const tail = promise.then(() => undefined, () => undefined)
    this.tails.set(laneId, tail)
    tail.finally(() => {
      if (this.tails.get(laneId) === tail) this.tails.delete(laneId)
    })
    this.commands.set(commandId, { record, promise })
    this.emit(record)
    return { record, promise, reused: false }
  }

  get(commandId: string): CommandRecordV1 | undefined {
    return this.commands.get(commandId)?.record
  }
}
