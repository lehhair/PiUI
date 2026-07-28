const generation = "limited-generation"
const heartbeatIntervalMs = 20
const heartbeatTimer = setInterval(() => {
  process.send?.({ kind: "heartbeat", generation, timestamp: Date.now() })
}, heartbeatIntervalMs)

process.send?.({
  kind: "hello",
  workerProtocolVersion: 11,
  piSdkVersion: "0.81.1",
  generation,
  processId: process.pid,
  heartbeatIntervalMs,
  capabilities: [],
})

process.on("message", request => {
  if (request.command?.type !== "dispose") return
  process.send?.({ kind: "response", id: request.id, generation, ok: true, result: { type: "ok" } })
  clearInterval(heartbeatTimer)
  setImmediate(() => process.exit(0))
})
