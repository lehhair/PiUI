let session
let listCount = 0
const generation = "fixture-generation"
const heartbeatIntervalMs = 20
const heartbeatTimer = setInterval(() => {
  process.send?.({ kind: "heartbeat", generation, timestamp: Date.now() })
}, heartbeatIntervalMs)

process.send?.({
  kind: "hello",
  workerProtocolVersion: 3,
  piSdkVersion: "0.81.1",
  generation,
  processId: process.pid,
  heartbeatIntervalMs,
  capabilities: [
    "catalog.sessions",
    "catalog.models",
    "runtime.open",
    "runtime.prompt",
    "runtime.abort",
    "runtime.model",
    "runtime.thinking",
    "runtime.compact",
    "runtime.skills",
    "runtime.commands",
  ],
})

function state() {
  return {
    thinkingLevel: "medium",
    availableThinkingLevels: ["off", "medium"],
    isStreaming: false,
    isCompacting: false,
    queue: { steering: [], followUp: [] },
    activeTools: ["read"],
    retryAttempt: 0,
  }
}

function snapshot() {
  return {
    sessionId: "fixture-session",
    sessionFile: "/fixture/session.jsonl",
    sessionName: "Fixture",
    projection: { timeline: [], isStreaming: false },
    state: state(),
    entries: [],
    tree: [],
    leafId: null,
  }
}

process.on("message", request => {
  if (request.generation !== generation) {
    process.send?.({
      kind: "response",
      id: request.id,
      generation,
      ok: false,
      error: { code: "WORKER_GENERATION_MISMATCH", message: "generation mismatch" },
    })
    return
  }
  const command = request.command
  let result
  if (command.type === "list" || command.type === "listAll") {
    listCount += 1
    result = {
      type: "sessions",
      sessions: [{
        id: "fixture-session",
        path: "/fixture/session.jsonl",
        cwd: "/fixture",
        name: `Fixture ${listCount}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
    }
  } else if (command.type === "listModels") {
    result = { type: "models", models: [{ id: "fixture-model", name: "Fixture", providerId: "fixture", family: "fixture", contextLimit: 1, outputLimit: 1, supportsReasoning: false, supportsImages: false }] }
  } else if (command.type === "open") {
    if (command.cwd.includes("hang-open")) return
    session = snapshot()
    result = { type: "session", session }
  } else if (command.type === "prompt") {
    if (command.text === "crash") {
      process.exit(17)
      return
    }
    if (command.text === "hang") {
      clearInterval(heartbeatTimer)
      return
    }
    if (command.text === "wait") {
      setTimeout(() => {
        process.send?.({ kind: "response", id: request.id, generation, ok: true, result: { type: "session", session: session ?? snapshot() } })
      }, 120)
      return
    }
    if (command.text === "stale") {
      process.send?.({
        kind: "event",
        generation: "stale-generation",
        type: "projection",
        projection: {
          timeline: [{ type: "user", id: "stale-entry", entryId: "stale-entry", timestamp: 1, text: "stale" }],
          isStreaming: false,
        },
      })
      result = { type: "session", session: session ?? snapshot() }
      process.send?.({ kind: "response", id: request.id, generation, ok: true, result })
      return
    }
    const projection = {
      timeline: [{ type: "user", id: "fixture-entry", entryId: "fixture-entry", timestamp: 1, text: command.text }],
      isStreaming: false,
    }
    session = { ...(session ?? snapshot()), projection }
    process.send?.({ kind: "event", generation, type: "projection", projection })
    result = { type: "session", session }
  } else if (command.type === "listSkills") {
    result = { type: "skills", skills: [{ name: "fixture-skill", source: "fixture" }] }
  } else if (command.type === "listCommands") {
    result = { type: "commands", commands: [{ name: "fixture-command", source: "builtin" }] }
  } else if (command.type === "dispose") {
    result = { type: "ok" }
  } else {
    result = { type: "session", session: session ?? snapshot() }
  }
  process.send?.({ kind: "response", id: request.id, generation, ok: true, result })
  if (command.type === "dispose") {
    clearInterval(heartbeatTimer)
    setImmediate(() => process.exit(0))
  }
})
