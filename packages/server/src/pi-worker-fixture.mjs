let session
let listCount = 0

process.send?.({
  kind: "hello",
  workerProtocolVersion: 2,
  piSdkVersion: "0.81.1",
  generation: "fixture-generation",
  processId: process.pid,
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
    session = snapshot()
    result = { type: "session", session }
  } else if (command.type === "prompt") {
    if (command.text === "crash") {
      process.exit(17)
      return
    }
    const projection = {
      timeline: [{ type: "user", id: "fixture-entry", entryId: "fixture-entry", timestamp: 1, text: command.text }],
      isStreaming: false,
    }
    session = { ...(session ?? snapshot()), projection }
    process.send?.({ kind: "event", type: "projection", projection })
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
  process.send?.({ kind: "response", id: request.id, ok: true, result })
  if (command.type === "dispose") setImmediate(() => process.exit(0))
})
