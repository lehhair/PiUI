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

  it("reads native session state while a prompt is streaming", async () => {
    const gate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async ({ command }) => {
      started.push(command.type)
      if (command.type === "prompt") await gate.promise
      return { type: "ok" }
    })

    const prompt = schedule(request({ type: "prompt", text: "hello" }))
    await Promise.resolve()
    await schedule(request({ type: "getNativeBranchPage", limit: 50, maxBytes: 1_000_000 }))
    await schedule(request({ type: "getNativeEntriesPage", limit: 50, maxBytes: 1_000_000 }))
    await schedule(request({ type: "getNativeTree" }))
    assert.deepEqual(started, ["prompt", "getNativeBranchPage", "getNativeEntriesPage", "getNativeTree"])

    gate.resolve()
    await prompt
  })

  it("runs extension slash commands immediately during a prompt", async () => {
    const gate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async ({ command }) => {
      started.push(command.type === "prompt" ? command.text : command.type)
      if (command.type === "prompt" && command.text === "hello") await gate.promise
      return { type: "ok" }
    })

    const prompt = schedule(request({ type: "prompt", text: "hello" }))
    await Promise.resolve()
    await schedule(request({ type: "prompt", text: "/extension-command now" }))
    const ordinary = schedule(request({ type: "prompt", text: "second turn" }))
    await Promise.resolve()
    assert.deepEqual(started, ["hello", "/extension-command now"])

    gate.resolve()
    await Promise.all([prompt, ordinary])
    assert.deepEqual(started, ["hello", "/extension-command now", "second turn"])
  })

  it("queues a user message that starts its own turn and lets queued delivery through", async () => {
    const gate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async ({ command }) => {
      started.push(command.type)
      if (command.type === "prompt") await gate.promise
      return { type: "ok" }
    })

    const prompt = schedule(request({ type: "prompt", text: "hello" }))
    await Promise.resolve()
    // Queued delivery joins the running turn.
    await schedule(request({ type: "sendUserMessage", text: "steered", deliverAs: "steer" }))
    assert.deepEqual(started, ["prompt", "sendUserMessage"])

    // Without deliverAs it would start a second turn, so it must wait.
    const standalone = schedule(request({ type: "sendUserMessage", text: "later" }))
    await Promise.resolve()
    assert.deepEqual(started, ["prompt", "sendUserMessage"])

    gate.resolve()
    await Promise.all([prompt, standalone])
    assert.deepEqual(started, ["prompt", "sendUserMessage", "sendUserMessage"])
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
