const generation = `catalog-fixture-${process.pid}`
const heartbeat = setInterval(() => {
  process.send?.({ kind: "heartbeat", generation, timestamp: Date.now() })
}, 20)

process.send?.({
  kind: "hello",
  workerProtocolVersion: 4,
  piSdkVersion: "0.81.1",
  generation,
  processId: process.pid,
  heartbeatIntervalMs: 20,
  capabilities: ["catalog.sessions", "catalog.models"],
})

process.on("message", request => {
  const command = request.command
  const result = command.type === "listModels"
    ? { type: "models", models: [] }
    : command.type === "dispose"
      ? { type: "ok" }
      : {
          type: "sessions",
          sessions: [{
            id: "catalog-fixture",
            path: "/fixture/session.jsonl",
            cwd: "/fixture",
            name: "Catalog fixture",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            messageCount: 0,
            firstMessage: "",
          }],
        }
  process.send?.({ kind: "response", id: request.id, generation, ok: true, result })
  if (command.type === "dispose") {
    clearInterval(heartbeat)
    setImmediate(() => process.exit(0))
  } else if (command.type === "list" || command.type === "listAll") {
    setImmediate(() => process.exit(17))
  }
})
