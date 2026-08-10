import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createWorkerCommandScheduler, type SchedulerCommand } from "./worker-command-scheduler.js"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe("createWorkerCommandScheduler", () => {
  it("executes commands immediately without serializing", async () => {
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
    // Native pi RPC semantics: a slow turn never blocks other commands.
    assert.deepEqual(started, ["prompt", "setModel"])
    gate.resolve()
    await prompt
    await model
    assert.deepEqual(started, ["prompt", "setModel"])
  })

  it("runs concurrent prompts without a barrier (SDK enforces its own constraints)", async () => {
    const firstGate = deferred()
    const secondGate = deferred()
    const started: string[] = []
    const schedule = createWorkerCommandScheduler(async (command: SchedulerCommand) => {
      started.push(command.params?.text ?? command.type)
      if (command.params?.text === "one") await firstGate.promise
      if (command.params?.text === "two") await secondGate.promise
      return undefined
    })

    const first = schedule({ type: "prompt", params: { text: "one" } })
    const second = schedule({ type: "prompt", params: { text: "two" } })
    await Promise.resolve()
    // Both prompts start immediately; whether the second is accepted is the
    // SDK's streamingBehavior decision, not a host-side queue.
    assert.deepEqual(started, ["one", "two"])

    secondGate.resolve()
    await second
    firstGate.resolve()
    await first
  })

  it("lets every command type run alongside an active prompt", async () => {
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
    await schedule({ type: "branch.get", params: {} })
    await schedule({ type: "setSessionName", params: { name: "renamed" } })
    await schedule({ type: "compact" })
    await schedule({ type: "bash", params: { command: "ls" } })
    assert.deepEqual(started, ["prompt", "abort", "branch.get", "setSessionName", "compact", "bash"])
    gate.resolve()
    await prompt
  })

  it("rejects new commands and waits for active work during close", async () => {
    const gate = deferred()
    let cleaned = false
    const schedule = createWorkerCommandScheduler(async (command: SchedulerCommand) => {
      if (command.type === "prompt") await gate.promise
      return undefined
    })

    const active = schedule({ type: "prompt", params: { text: "hello" } })
    await Promise.resolve()
    const closing = schedule.close(async () => {
      cleaned = true
    })
    await assert.rejects(schedule({ type: "state.get" }), { code: "RUNTIME_CLOSING" })
    assert.equal(cleaned, false)

    gate.resolve()
    await active
    await closing
    assert.equal(cleaned, true)
  })

  it("runs cleanup once when close is called repeatedly", async () => {
    let cleaned = 0
    const schedule = createWorkerCommandScheduler(async () => undefined)
    await schedule({ type: "state.get" })
    const first = schedule.close(async () => { cleaned += 1 })
    const second = schedule.close(async () => { cleaned += 1 })
    await first
    await second
    assert.equal(cleaned, 1)
  })
})
