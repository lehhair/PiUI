import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createWorkerCommandScheduler, type SchedulerCommand } from "./worker-command-scheduler.js"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe("createWorkerCommandScheduler", () => {
  it("serializes ordinary commands", async () => {
    const gate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async (command: SchedulerCommand) => {
      started.push(command.type)
      if (command.type === "prompt") await gate.promise
      return { ok: true }
    })

    const prompt = schedule({ type: "prompt", params: { text: "hello" } })
    const model = schedule({ type: "setModel", params: { provider: "test", modelId: "offline" } })
    await Promise.resolve()
    assert.deepEqual(started, ["prompt"])
    gate.resolve()
    await prompt
    await model
    assert.deepEqual(started, ["prompt", "setModel"])
  })

  it("lets steering controls run alongside an active prompt", async () => {
    const gate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async (command: SchedulerCommand) => {
      started.push(command.type)
      if (command.type === "prompt") await gate.promise
      return undefined
    })

    const prompt = schedule({ type: "prompt", params: { text: "hello" } })
    await Promise.resolve()
    await schedule({ type: "abort" })
    gate.resolve()
    await prompt
    assert.deepEqual(started, ["prompt", "abort"])
  })

  it("lets read-only queries run alongside an active prompt", async () => {
    const gate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async (command: SchedulerCommand) => {
      started.push(command.type)
      if (command.type === "prompt") await gate.promise
      return undefined
    })

    const prompt = schedule({ type: "prompt", params: { text: "hello" } })
    await Promise.resolve()
    await schedule({ type: "branch.get", params: {} })
    gate.resolve()
    await prompt
    assert.deepEqual(started, ["prompt", "branch.get"])
  })

  it("serializes two prompts", async () => {
    const gate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async (command: SchedulerCommand) => {
      started.push(command.type)
      if (command.type === "prompt") await gate.promise
      return undefined
    })

    const first = schedule({ type: "prompt", params: { text: "one" } })
    const second = schedule({ type: "prompt", params: { text: "two" } })
    await Promise.resolve()
    assert.deepEqual(started, ["prompt"])
    gate.resolve()
    await first
    await second
    assert.deepEqual(started, ["prompt", "prompt"])
  })

  it("lets queries and abort run alongside an active sendUserMessage turn", async () => {
    const gate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async (command: SchedulerCommand) => {
      started.push(command.type)
      if (command.type === "sendUserMessage" && command.params?.deliverAs === undefined) await gate.promise
      return undefined
    })

    const turn = schedule({ type: "sendUserMessage", params: { text: "hello" } })
    await Promise.resolve()
    // While the sendUserMessage turn is active, queries and abort must not block
    await schedule({ type: "state.get", params: {} })
    await schedule({ type: "branch.get", params: {} })
    await schedule({ type: "abort" })
    assert.deepEqual(started, ["sendUserMessage", "state.get", "branch.get", "abort"])
    gate.resolve()
    await turn
  })

  it("lets a queued sendUserMessage (deliverAs) run alongside an active turn", async () => {
    const gate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async (command: SchedulerCommand) => {
      started.push(command.type)
      if (command.type === "sendUserMessage" && command.params?.deliverAs === undefined) await gate.promise
      return undefined
    })

    const turn = schedule({ type: "sendUserMessage", params: { text: "hello" } })
    await Promise.resolve()
    await schedule({ type: "sendUserMessage", params: { text: "more", deliverAs: "followUp" } })
    assert.deepEqual(started, ["sendUserMessage", "sendUserMessage"])
    gate.resolve()
    await turn
  })
})
