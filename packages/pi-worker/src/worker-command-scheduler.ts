import type { JsonObject } from "@piui/protocol"

export interface SchedulerCommand {
  type: string
  params?: JsonObject
}

const QUERY_COMMANDS = new Set([
  "state.get",
  "entries.get",
  "branch.get",
  "tree.get",
  "registry.get",
])

function canRunConcurrently(command: SchedulerCommand, active: SchedulerCommand | undefined): boolean {
  const text = command.params?.text
  switch (command.type) {
    case "prompt":
      return active?.type === "prompt" && typeof text === "string" && /^\/[^\s/]+(?:\s|$)/.test(text)
    case "steer":
    case "followUp":
    case "abort":
    case "abortRetry":
    case "setSteeringMode":
    case "setFollowUpMode":
    case "clearQueue":
      return active?.type === "prompt"
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
      return active?.type === "prompt" && command.params?.deliverAs !== undefined
    default:
      if (QUERY_COMMANDS.has(command.type)) return active?.type === "prompt"
      return false
  }
}

export function createWorkerCommandScheduler<T>(
  execute: (command: SchedulerCommand) => Promise<T>,
): (command: SchedulerCommand) => Promise<T> {
  let queue: Promise<void> = Promise.resolve()
  let active: SchedulerCommand | undefined
  return command => {
    if (canRunConcurrently(command, active)) return execute(command)
    const result = queue.then(async () => {
      active = command
      try {
        return await execute(command)
      } finally {
        active = undefined
      }
    })
    queue = result.then(() => undefined, () => undefined)
    return result
  }
}
