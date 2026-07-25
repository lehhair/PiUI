import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PiWorkerSession } from "./pi-worker-client.ts"

const fixture = new URL("./pi-worker-fixture.mjs", import.meta.url)
const incompatibleFixture = new URL("./pi-worker-incompatible-fixture.mjs", import.meta.url)
const limitedFixture = new URL("./pi-worker-limited-fixture.mjs", import.meta.url)

describe("PiWorkerSession IPC", () => {
  it("lists sessions through an isolated worker process", async () => {
    const sessions = await PiWorkerSession.listAll(fixture)
    assert.equal(sessions[0]?.id, "fixture-session")
    const models = await PiWorkerSession.listModels(fixture)
    assert.equal(models[0]?.id, "fixture-model")
  })

  it("reuses one catalog worker for repeated scoped and global lists", async () => {
    const catalog = PiWorkerSession.createCatalog(fixture)
    try {
      const hello = await catalog.getHandshake()
      assert.equal(hello.workerProtocolVersion, 2)
      assert.equal(hello.piSdkVersion, "0.81.1")
      assert.equal(hello.generation, "fixture-generation")
      const first = await catalog.listAll()
      const second = await catalog.list("/fixture")
      assert.equal(first[0]?.name, "Fixture 1")
      assert.equal(second[0]?.name, "Fixture 2")
    } finally {
      await catalog.dispose()
    }
  })

  it("rejects an incompatible worker before sending commands", async () => {
    await assert.rejects(PiWorkerSession.listAll(incompatibleFixture), /worker protocol mismatch/i)
  })

  it("rejects commands missing from the worker capability handshake", async () => {
    await assert.rejects(PiWorkerSession.listAll(limitedFixture), error => {
      assert.equal((error as { code?: string }).code, "CAPABILITY_DISABLED")
      return true
    })
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

  it("opens one session through a pre-spawned host", async () => {
    const host = PiWorkerSession.createHost(fixture)
    const runtime = await host.open("/fixture", "/fixture/session.jsonl")
    try {
      assert.equal(runtime.getSessionId(), "fixture-session")
      await assert.rejects(host.open("/fixture"), /already in use/)
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
