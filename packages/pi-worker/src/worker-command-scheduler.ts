import type { WorkerCommand, WorkerRequest, WorkerResult } from "./worker-protocol.js"

function canRunConcurrently(command: WorkerCommand, active: WorkerCommand | undefined): boolean {
  switch (command.type) {
    case "prompt":
      // Pi resolves extension slash commands before checking the streaming
      // guard, so these must reach AgentSession immediately during a turn.
      return active?.type === "prompt" && /^\/[^\s/]+(?:\s|$)/.test(command.text)
    case "steer":
    case "followUp":
    case "abort":
    case "abortRetry":
    case "setQueueModes":
    case "clearQueue":
      return active?.type === "prompt"
    case "getNativeEntriesPage":
    case "getNativeBranchPage":
    case "getNativeTree":
    case "getNativeImageAttachment":
      return active?.type === "prompt"
    case "abortCompaction":
      return active?.type === "compact"
    case "abortBranchSummary":
      return active?.type === "navigateTree"
    case "abortBash":
      return active?.type === "executeBash"
    case "respondExtensionUi":
    case "setExtensionEditorState":
    case "respondProviderAuth":
    case "cancelProviderAuth":
      return true
    case "sendCustomMessage":
      return active?.type === "prompt" && command.deliverAs !== undefined
    // Only queued delivery is safe alongside a turn; without deliverAs the SDK
    // starts a new turn, which must not interleave with the active command.
    case "sendUserMessage":
      return active?.type === "prompt" && command.deliverAs !== undefined
    default:
      return false
  }
}

export function createWorkerCommandScheduler(
  execute: (request: WorkerRequest) => Promise<WorkerResult>,
): (request: WorkerRequest) => Promise<WorkerResult> {
  let queue: Promise<void> = Promise.resolve()
  let active: WorkerCommand | undefined
  return request => {
    if (canRunConcurrently(request.command, active)) return execute(request)
    const result = queue.then(async () => {
      active = request.command
      try {
        return await execute(request)
      } finally {
        active = undefined
      }
    })
    queue = result.then(() => undefined, () => undefined)
    return result
  }
}
