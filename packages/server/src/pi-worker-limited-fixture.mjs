process.send?.({
  kind: "hello",
  workerProtocolVersion: 2,
  piSdkVersion: "0.81.1",
  generation: "limited-generation",
  processId: process.pid,
  capabilities: [],
})

process.on("message", request => {
  if (request.command?.type !== "dispose") return
  process.send?.({ kind: "response", id: request.id, ok: true, result: { type: "ok" } })
  setImmediate(() => process.exit(0))
})
