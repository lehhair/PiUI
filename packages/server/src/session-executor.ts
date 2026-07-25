import type {
  CommandRecordV2,
  CommandRequestV2,
  CommandTypeV2,
} from "@piui/protocol"

interface CommandEntry {
  record: CommandRecordV2
  promise: Promise<unknown>
}

export interface SubmittedCommand<T, C extends CommandTypeV2 = CommandTypeV2> {
  record: CommandRecordV2<C>
  promise: Promise<T>
  reused: boolean
}

export class SessionExecutor {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly commands = new Map<string, CommandEntry>()

  constructor(private readonly onUpdate?: (record: CommandRecordV2) => void) {}

  submit<T, C extends CommandTypeV2>(request: CommandRequestV2<C>, run: () => Promise<T>): SubmittedCommand<T, C> {
    const existing = this.commands.get(request.commandId)
    if (existing) {
      if (
        existing.record.request.sessionId !== request.sessionId ||
        existing.record.request.workspaceId !== request.workspaceId ||
        existing.record.request.type !== request.type
      ) {
        throw Object.assign(new Error("commandId already used for another command"), { code: "COMMAND_CONFLICT" })
      }
      return {
        record: existing.record as CommandRecordV2<C>,
        promise: existing.promise as Promise<T>,
        reused: true,
      }
    }

    const record: CommandRecordV2<C> = {
      request,
      status: "accepted",
      submittedAt: new Date().toISOString(),
    }
    const laneId = commandLane(request)
    const previous = laneId ? (this.tails.get(laneId) ?? Promise.resolve()) : Promise.resolve()
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

    if (laneId) {
      const tail = promise.then(() => undefined, () => undefined)
      this.tails.set(laneId, tail)
      tail.finally(() => {
        if (this.tails.get(laneId) === tail) this.tails.delete(laneId)
      })
    }
    this.commands.set(request.commandId, { record, promise })
    this.emit(record)
    return { record, promise, reused: false }
  }

  get(commandId: string): CommandRecordV2 | undefined {
    return this.commands.get(commandId)?.record
  }

  private emit(record: CommandRecordV2): void {
    this.onUpdate?.({
      ...record,
      request: { ...record.request, payload: { ...record.request.payload } },
      error: record.error ? { ...record.error } : undefined,
    })
  }
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
