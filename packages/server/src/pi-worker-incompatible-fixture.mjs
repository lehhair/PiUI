process.send?.({
  kind: "hello",
  workerProtocolVersion: 1,
  piSdkVersion: "0.81.1",
  generation: "incompatible-generation",
  processId: process.pid,
  capabilities: [],
})

process.on("message", () => {})
