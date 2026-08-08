// Worker IPC fixture for WorkerSession fault-injection tests.
//
// Modes (env PIUI_FIXTURE_MODE):
//   hello-ok          — full protocol: hello + heartbeats + request replies
//   silent            — hello + request replies, but never heartbeats
//   exit-on-request   — hello + heartbeats, then exit(1) on the first request
//   wrong-protocol    — hello with a bumped protocol version, then idle
//
// Heartbeat cadence comes from PIUI_FIXTURE_HEARTBEAT_MS (default 20ms) so the
// client watchdog fires quickly without slowing the suite.
import { PI_WORKER_PROTOCOL_VERSION } from "../../../pi-worker/src/ipc.ts"

const mode = process.env.PIUI_FIXTURE_MODE ?? "hello-ok"
const heartbeatIntervalMs = Number(process.env.PIUI_FIXTURE_HEARTBEAT_MS ?? 20)
const generation = "fixture-gen"

const send = (message) => process.send?.(message)

send({
  kind: "hello",
  workerProtocolVersion: mode === "wrong-protocol" ? PI_WORKER_PROTOCOL_VERSION + 1 : PI_WORKER_PROTOCOL_VERSION,
  piSdkVersion: "0.84.0",
  piSdkVerified: true,
  generation,
  processId: process.pid,
  heartbeatIntervalMs,
})

if (mode === "silent" || mode === "wrong-protocol") {
  // Never heartbeat. The client settles the ready error on the wrong protocol
  // version and never talks to us again; exit shortly so dispose() resolves
  // quickly instead of waiting out its kill timeout.
  process.on("message", () => {})
  if (mode === "wrong-protocol") {
    setTimeout(() => process.exit(0), 50).unref?.()
  }
} else {
  const heartbeat = setInterval(() => {
    send({ kind: "heartbeat", generation, timestamp: Date.now() })
  }, heartbeatIntervalMs)
  heartbeat.unref?.()

  if (mode === "exit-on-request") {
    process.on("message", message => {
      if (message && typeof message === "object" && message.kind === "request") {
        process.exit(1)
      }
    })
  } else {
    process.on("message", message => {
      if (!message || typeof message !== "object" || message.kind !== "request") return
      const reply = { kind: "response", id: message.id, generation, ok: true, data: { fixture: "ok" } }
      send(reply)
      // Mirror the real worker: acknowledge dispose, then exit so the client's
      // dispose() doesn't wait out its 5s kill timeout.
      if (message.command?.type === "dispose") {
        setImmediate(() => process.exit(0))
      }
    })
  }
}
