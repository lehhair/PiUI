import type { JsonObject } from "@piui/protocol"

export interface SchedulerCommand {
  type: string
  params?: JsonObject
  sessionId?: string
}

const QUERY_COMMANDS = new Set([
  "state.get",
  "entries.get",
  "branch.get",
  "tree.get",
  "registry.get",
])

function canRunConcurrently(
  command: SchedulerCommand,
  active: SchedulerCommand | undefined,
  concurrentPrompts: number,
): boolean {
  const text = command.params?.text
  // sendUserMessage is semantically a prompt (SDK runs prompt(streamingBehavior)
  // under the hood) — query, queue, and abort commands must not block behind
  // it for the whole turn, or streaming state reads and aborts would only
  // land after the turn ends.
  const activeIsPrompt = concurrentPrompts > 0 || active?.type === "prompt" || active?.type === "sendUserMessage"
  switch (command.type) {
    case "prompt":
      return activeIsPrompt && typeof text === "string" && /^\/[^\s/]+(?:\s|$)/.test(text)
    case "steer":
    case "followUp":
    case "abort":
    case "abortRetry":
    case "setSteeringMode":
    case "setFollowUpMode":
    case "clearQueue":
      return activeIsPrompt
    case "abortCompaction":
      return active?.type === "compact"
    case "abortBranchSummary":
      return active?.type === "navigateTree"
    case "abortBash":
      return active?.type === "bash"
    case "respondExtensionUi":
    case "setExtensionEditorState":
    case "providers.respondAuth":
    case "providers.cancelAuth":
      return true
    case "sendCustomMessage":
    case "sendUserMessage":
      return activeIsPrompt && command.params?.deliverAs !== undefined
    default:
      if (QUERY_COMMANDS.has(command.type)) return activeIsPrompt
      return false
  }
}

export function createWorkerCommandScheduler<T>(
  execute: (command: SchedulerCommand) => Promise<T>,
): ((command: SchedulerCommand) => Promise<T>) & { close: (cleanup: () => Promise<void>) => Promise<void> } {
  let queue: Promise<void> = Promise.resolve()
  let active: SchedulerCommand | undefined
  const concurrentOperations = new Set<Promise<unknown>>()
  const concurrentPrompts = new Set<Promise<unknown>>()
  let closing = false
  let closePromise: Promise<void> | undefined

  const trackConcurrent = (command: SchedulerCommand, result: Promise<T>): Promise<T> => {
    concurrentOperations.add(result)
    if (command.type === "prompt" || command.type === "sendUserMessage") concurrentPrompts.add(result)
    const remove = () => {
      concurrentOperations.delete(result)
      concurrentPrompts.delete(result)
    }
    void result.then(remove, remove)
    return result
  }

  const schedule = ((command: SchedulerCommand): Promise<T> => {
    if (closing) {
      return Promise.reject(Object.assign(new Error("worker scheduler is closing"), { code: "RUNTIME_CLOSING" }))
    }

    if (canRunConcurrently(command, active, concurrentPrompts.size)) {
      return trackConcurrent(command, execute(command))
    }
    const result = queue.then(async () => {
      // Serial commands are barriers. In particular, a normal prompt must not
      // begin while a slash prompt or queued native delivery is still active.
      if (concurrentOperations.size > 0) await Promise.allSettled([...concurrentOperations])
      active = command
      try {
        return await execute(command)
      } finally {
        active = undefined
      }
    })
    queue = result.then(() => undefined, () => undefined)
    return result
  }) as ((command: SchedulerCommand) => Promise<T>) & { close: (cleanup: () => Promise<void>) => Promise<void> }

  schedule.close = (cleanup: () => Promise<void>): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    closePromise = queue.then(async () => {
      await Promise.allSettled([...concurrentOperations])
      await cleanup()
    })
    return closePromise
  }

  return schedule
}
