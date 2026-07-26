import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createWorkerCommandScheduler } from "./worker-command-scheduler.js"
import type { WorkerCommand, WorkerRequest, WorkerResult } from "./worker-protocol.js"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

let requestId = 0
function request(command: WorkerCommand): WorkerRequest {
  return { kind: "request", id: String(++requestId), generation: "test", command }
}

describe("createWorkerCommandScheduler", () => {
  it("serializes ordinary commands", async () => {
    const gate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async ({ command }) => {
      started.push(command.type)
      if (command.type === "prompt") await gate.promise
      return { type: "ok" }
    })

    const prompt = schedule(request({ type: "prompt", text: "hello" }))
    const model = schedule(request({ type: "setModel", provider: "test", modelId: "offline" }))
    await Promise.resolve()
    assert.deepEqual(started, ["prompt"])

    gate.resolve()
    await Promise.all([prompt, model])
    assert.deepEqual(started, ["prompt", "setModel"])
  })

  it("runs control commands while an ordinary command is pending", async () => {
    const gate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async ({ command }) => {
      started.push(command.type)
      if (command.type === "prompt") await gate.promise
      return { type: "ok" }
    })

    const prompt = schedule(request({ type: "prompt", text: "hello" }))
    await Promise.resolve()
    await schedule(request({
      type: "respondExtensionUi",
      requestId: "request",
      response: { kind: "cancelled" },
    }))
    assert.deepEqual(started, ["prompt", "respondExtensionUi"])

    gate.resolve()
    await prompt
  })

  it("continues after a command fails", async () => {
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async ({ command }) => {
      started.push(command.type)
      if (command.type === "reload") throw new Error("reload failed")
      return { type: "ok" } satisfies WorkerResult
    })

    await assert.rejects(schedule(request({ type: "reload" })), /reload failed/)
    await schedule(request({ type: "listCommands" }))
    assert.deepEqual(started, ["reload", "listCommands"])
  })
})
