import { randomUUID } from "node:crypto"
import { PI_PARITY_SDK_VERSION } from "@piui/protocol"
import { RealPiSession } from "./real-session.js"
import type { PiSessionRuntime } from "./runtime-contract.js"
import {
  PI_WORKER_PROTOCOL_VERSION,
  PI_WORKER_HEARTBEAT_INTERVAL_MS,
  type PiWorkerCapability,
  type ProjectionWire,
  type WorkerCommand,
  type WorkerMessage,
  type WorkerRequest,
  type WorkerResult,
  type WorkerSessionWire,
} from "./worker-protocol.js"

let runtime: PiSessionRuntime | undefined
let unsubscribeState: (() => void) | undefined
let unsubscribeProjectionDelta: (() => void) | undefined
const workerGeneration = randomUUID()
const heartbeatTimer = setInterval(() => {
  send({ kind: "heartbeat", generation: workerGeneration, timestamp: Date.now() })
}, PI_WORKER_HEARTBEAT_INTERVAL_MS)
heartbeatTimer.unref()
const workerCapabilities: PiWorkerCapability[] = [
  "catalog.sessions",
  "catalog.models",
  "runtime.open",
  "runtime.prompt",
  "runtime.control",
  "runtime.abort",
  "runtime.model",
  "runtime.thinking",
  "runtime.compact",
  "runtime.retry",
  "runtime.tools",
  "runtime.tree",
  "runtime.fork",
  "runtime.import",
  "runtime.skills",
  "runtime.commands",
]

function send(message: WorkerMessage): void {
  process.send?.(message)
}

function projectionWire(value: ProjectionWire = requireRuntime().getProjection()): ProjectionWire {
  return {
    timeline: value.timeline,
    isStreaming: value.isStreaming,
    removedItemIds: value.removedItemIds,
  }
}

function sessionWire(): WorkerSessionWire {
  const current = requireRuntime()
  return {
    sessionId: current.getSessionId(),
    sessionFile: current.getSessionFile(),
    sessionName: current.getSessionName(),
    projection: projectionWire(current.getProjection()),
    state: current.getRuntimeUiState(),
    entries: current.getEntries(),
    tree: current.getTree(),
    leafId: current.getLeafId(),
  }
}

function requireRuntime(): PiSessionRuntime {
  if (!runtime) throw Object.assign(new Error("Pi runtime is not open"), { code: "RUNTIME_NOT_OPEN" })
  return runtime
}

async function execute(command: WorkerCommand): Promise<WorkerResult> {
  switch (command.type) {
    case "list":
      return { type: "sessions", sessions: await RealPiSession.list(command.cwd) }
    case "listAll":
      return { type: "sessions", sessions: await RealPiSession.listAll() }
    case "listModels":
      return { type: "models", models: await RealPiSession.listModels() }
    case "open": {
      if (runtime) throw Object.assign(new Error("Pi runtime is already open"), { code: "RUNTIME_ALREADY_OPEN" })
      runtime = await RealPiSession.open(command.cwd, command.sessionFile)
      unsubscribeState = runtime.onState(state => send({
        kind: "event",
        generation: workerGeneration,
        type: "state",
        state,
      }))
      unsubscribeProjectionDelta = runtime.onProjectionDelta(projection => send({
        kind: "event",
        generation: workerGeneration,
        type: "projectionDelta",
        projection: projectionWire(projection),
      }))
      return { type: "session", session: sessionWire() }
    }
    case "prompt": {
      await requireRuntime().prompt(command.text)
      return { type: "session", session: sessionWire() }
    }
    case "steer":
      await requireRuntime().steer(command.text)
      return { type: "session", session: sessionWire() }
    case "followUp":
      await requireRuntime().followUp(command.text)
      return { type: "session", session: sessionWire() }
    case "abort":
      return { type: "queue", ...await requireRuntime().abort(), session: sessionWire() }
    case "setModel":
      await requireRuntime().setModel(command.provider, command.modelId)
      return { type: "session", session: sessionWire() }
    case "setThinkingLevel":
      await requireRuntime().setThinkingLevel(command.level)
      return { type: "session", session: sessionWire() }
    case "compact": {
      const compaction = await requireRuntime().compact(command.instructions)
      return { type: "compaction", compaction, session: sessionWire() }
    }
    case "abortCompaction":
      await requireRuntime().abortCompaction()
      return { type: "session", session: sessionWire() }
    case "abortBranchSummary":
      await requireRuntime().abortBranchSummary()
      return { type: "session", session: sessionWire() }
    case "abortRetry":
      await requireRuntime().abortRetry()
      return { type: "session", session: sessionWire() }
    case "setAutoCompaction":
      await requireRuntime().setAutoCompaction(command.enabled)
      return { type: "session", session: sessionWire() }
    case "setAutoRetry":
      await requireRuntime().setAutoRetry(command.enabled)
      return { type: "session", session: sessionWire() }
    case "setQueueModes":
      await requireRuntime().setQueueModes(command)
      return { type: "session", session: sessionWire() }
    case "clearQueue": {
      const queue = await requireRuntime().clearQueue()
      return { type: "queue", ...queue, session: sessionWire() }
    }
    case "setActiveTools":
      await requireRuntime().setActiveTools(command.toolNames)
      return { type: "session", session: sessionWire() }
    case "navigateTree": {
      const result = await requireRuntime().navigateTree(command.entryId, {
        summarize: command.summarize,
        customInstructions: command.customInstructions,
        replaceInstructions: command.replaceInstructions,
        label: command.label,
      })
      return { type: "navigation", ...result, session: sessionWire() }
    }
    case "setLabel":
      await requireRuntime().setLabel(command.entryId, command.label)
      return { type: "session", session: sessionWire() }
    case "setSessionName":
      await requireRuntime().setSessionName(command.name)
      return { type: "session", session: sessionWire() }
    case "fork": {
      const replacement = await requireRuntime().fork(command.entryId, command.position)
      return { type: "replacement", replacement, session: sessionWire() }
    }
    case "clone": {
      const replacement = await requireRuntime().clone(command.entryId)
      return { type: "replacement", replacement, session: sessionWire() }
    }
    case "importSession": {
      const replacement = await requireRuntime().importSession(command.inputPath, command.cwdOverride)
      return { type: "replacement", replacement, session: sessionWire() }
    }
    case "listSkills":
      return { type: "skills", skills: await requireRuntime().listSkills() }
    case "listCommands":
      return { type: "commands", commands: await requireRuntime().listCommands() }
    case "dispose":
      clearInterval(heartbeatTimer)
      unsubscribeState?.()
      unsubscribeState = undefined
      unsubscribeProjectionDelta?.()
      unsubscribeProjectionDelta = undefined
      await runtime?.dispose()
      runtime = undefined
      return { type: "ok" }
  }
}

process.on("message", (value: unknown) => {
  const request = value as WorkerRequest
  if (!request || request.kind !== "request" || typeof request.id !== "string") return
  if (request.generation !== workerGeneration) {
    send({
      kind: "response",
      id: request.id,
      generation: workerGeneration,
      ok: false,
      error: { code: "WORKER_GENERATION_MISMATCH", message: "Pi worker generation mismatch" },
    })
    return
  }
  void execute(request.command).then(
    result => {
      send({ kind: "response", id: request.id, generation: workerGeneration, ok: true, result })
      if (request.command.type === "dispose") setImmediate(() => process.exit(0))
    },
    error => {
      send({
        kind: "response",
        id: request.id,
        generation: workerGeneration,
        ok: false,
        error: {
          code: error && typeof error === "object" && "code" in error ? String(error.code) : "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    },
  )
})

send({
  kind: "hello",
  workerProtocolVersion: PI_WORKER_PROTOCOL_VERSION,
  piSdkVersion: PI_PARITY_SDK_VERSION,
  generation: workerGeneration,
  processId: process.pid,
  heartbeatIntervalMs: PI_WORKER_HEARTBEAT_INTERVAL_MS,
  capabilities: workerCapabilities,
})

process.on("disconnect", () => {
  clearInterval(heartbeatTimer)
  void (runtime?.dispose() ?? Promise.resolve()).finally(() => process.exit(0))
})
