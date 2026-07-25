import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PiWorkerSession } from "./pi-worker-client.ts"

const fixture = new URL("./pi-worker-fixture.mjs", import.meta.url)

describe("PiWorkerSession IPC", () => {
  it("lists sessions through an isolated worker process", async () => {
    const sessions = await PiWorkerSession.listAll(fixture)
    assert.equal(sessions[0]?.id, "fixture-session")
    const models = await PiWorkerSession.listModels(fixture)
    assert.equal(models[0]?.id, "fixture-model")
  })

  it("opens a runtime and proxies native commands", async () => {
    const runtime = await PiWorkerSession.open("/fixture", "/fixture/session.jsonl", fixture)
    try {
      assert.equal(runtime.getSessionId(), "fixture-session")
      assert.equal(runtime.getSessionName(), "Fixture")
      assert.equal((await runtime.listSkills())[0]?.name, "fixture-skill")
      assert.equal((await runtime.listCommands())[0]?.name, "fixture-command")
      let ticks = 0
      await runtime.prompt("hello", () => { ticks += 1 })
      assert.equal(ticks > 0, true)
      assert.equal(runtime.getProjection().timeline[0]?.entryId, "fixture-entry")
    } finally {
      await runtime.dispose()
    }
  })

  it("rejects pending commands when the worker crashes", async () => {
    const runtime = await PiWorkerSession.open("/fixture", "/fixture/session.jsonl", fixture)
    await assert.rejects(runtime.prompt("crash"), /exited unexpectedly/)
    await runtime.dispose()
  })
})
