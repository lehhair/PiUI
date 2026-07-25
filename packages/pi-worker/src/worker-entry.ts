import { RealPiSession } from "./real-session.js"
import type { PiSessionRuntime } from "./runtime-contract.js"
import type {
  ProjectionWire,
  WorkerCommand,
  WorkerMessage,
  WorkerRequest,
  WorkerResult,
  WorkerSessionWire,
} from "./worker-protocol.js"

let runtime: PiSessionRuntime | undefined
let unsubscribeState: (() => void) | undefined

function send(message: WorkerMessage): void {
  process.send?.(message)
}

function projectionWire(value = requireRuntime().getProjection()): ProjectionWire {
  return { timeline: value.timeline, isStreaming: value.isStreaming }
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
    case "listAll":
      return { type: "sessions", sessions: await RealPiSession.listAll() }
    case "listModels":
      return { type: "models", models: await RealPiSession.listModels() }
    case "open": {
      if (runtime) throw Object.assign(new Error("Pi runtime is already open"), { code: "RUNTIME_ALREADY_OPEN" })
      runtime = await RealPiSession.open(command.cwd, command.sessionFile)
      unsubscribeState = runtime.onState(state => send({ kind: "event", type: "state", state }))
      return { type: "session", session: sessionWire() }
    }
    case "prompt": {
      const current = requireRuntime()
      await current.prompt(
        command.text,
        projection => send({ kind: "event", type: "projection", projection: projectionWire(projection) }),
        { deliverAs: command.deliverAs },
      )
      return { type: "session", session: sessionWire() }
    }
    case "abort":
      await requireRuntime().abort()
      return { type: "session", session: sessionWire() }
    case "setModel":
      await requireRuntime().setModel(command.provider, command.modelId)
      return { type: "session", session: sessionWire() }
    case "setThinkingLevel":
      await requireRuntime().setThinkingLevel(command.level)
      return { type: "session", session: sessionWire() }
    case "compact":
      await requireRuntime().compact(command.instructions)
      return { type: "session", session: sessionWire() }
    case "listSkills":
      return { type: "skills", skills: await requireRuntime().listSkills() }
    case "listCommands":
      return { type: "commands", commands: await requireRuntime().listCommands() }
    case "dispose":
      unsubscribeState?.()
      unsubscribeState = undefined
      await runtime?.dispose()
      runtime = undefined
      return { type: "ok" }
  }
}

process.on("message", (value: unknown) => {
  const request = value as WorkerRequest
  if (!request || request.kind !== "request" || typeof request.id !== "string") return
  void execute(request.command).then(
    result => {
      send({ kind: "response", id: request.id, ok: true, result })
      if (request.command.type === "dispose") setImmediate(() => process.exit(0))
    },
    error => {
      send({
        kind: "response",
        id: request.id,
        ok: false,
        error: {
          code: error && typeof error === "object" && "code" in error ? String(error.code) : "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    },
  )
})

process.on("disconnect", () => {
  void (runtime?.dispose() ?? Promise.resolve()).finally(() => process.exit(0))
})
