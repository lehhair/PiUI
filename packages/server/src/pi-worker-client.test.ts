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
      assert.equal(hello.workerProtocolVersion, 11)
      assert.equal(hello.piSdkVersion, "0.81.1")
      assert.equal(hello.generation, "fixture-generation")
      const first = await catalog.listAll()
      const second = await catalog.list("/fixture")
      assert.equal(first[0]?.name, "Fixture 1")
      assert.equal(second[0]?.name, "Fixture 2")
      assert.equal((await catalog.getSettings("/fixture")).projectTrusted, true)
      assert.deepEqual((await catalog.patchSettings("/fixture", { theme: "dark" })).effective, { theme: "dark" })
      assert.equal((await catalog.getProjectTrust("/fixture")).decision, null)
      assert.equal((await catalog.setProjectTrust("/fixture", false)).trusted, false)
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
      let deltas = 0
      const nativeEvents: unknown[] = []
      const nativeHeads: unknown[] = []
      const unsubscribe = runtime.onProjection(() => { ticks += 1 })
      const unsubscribeDelta = runtime.onProjectionDelta(() => { deltas += 1 })
      const unsubscribeNative = runtime.onNativeEvent(event => { nativeEvents.push(event) })
      const unsubscribeNativeHead = runtime.onNativeHead(native => { nativeHeads.push(native) })
      await runtime.prompt("hello", [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }])
      unsubscribe()
      unsubscribeDelta()
      unsubscribeNative()
      unsubscribeNativeHead()
      assert.equal(ticks > 1, true)
      assert.equal(deltas, 1)
      assert.deepEqual(nativeEvents, [{ type: "turn_start", turnIndex: 0 }])
      assert.equal(nativeHeads.length, 1)
      assert.equal(runtime.getProjection().timeline[0]?.entryId, "fixture-entry")
      let nativePage = await runtime.getNativeEntriesPage(undefined, 50, 1_000_000)
      assert.equal(nativePage.items[0]?.type, "message")
      assert.deepEqual(nativePage.items[0]?.futureField, {
        unknown: [1, "two", false, null],
      })
      assert.deepEqual(nativePage.items[1], {
        type: "future_pi_entry",
        id: "future-entry",
        parentId: "fixture-entry",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { untouched: { deep: ["value"] } },
      })
      const message = nativePage.items[0]?.message as { content?: unknown[] }
      assert.deepEqual(message.content?.[1], { type: "image", mimeType: "image/png", data: "aW1hZ2U=" })
      assert.equal(runtime.getNativeHead().entryCount, 2)
      assert.equal((await runtime.navigateTree("fixture-entry")).editorText, "fixture draft")
      await runtime.setLabel("fixture-entry", "checkpoint")
      nativePage = await runtime.getNativeEntriesPage(undefined, 50, 1_000_000)
      assert.equal(nativePage.items.at(-1)?.label, "checkpoint")
      await runtime.setSessionName("Renamed fixture")
      assert.equal(runtime.getSessionName(), "Renamed fixture")
      await runtime.prompt("image", [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }])
      assert.deepEqual(await runtime.executeBash("git status", true), {
        output: "fixture bash: git status",
        exitCode: 0,
        cancelled: false,
        truncated: false,
      })
      await runtime.abortBash()
      assert.equal(await runtime.exportHtml("/fixture/export.html"), "/fixture/export.html")
      assert.equal(await runtime.exportJsonl("/fixture/export.jsonl"), "/fixture/export.jsonl")
      await runtime.reload()
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

  it("tracks the runtime session identity across a replacement", async () => {
    const runtime = await PiWorkerSession.open("/fixture", "/fixture/session.jsonl", fixture)
    try {
      assert.equal(runtime.getSessionId(), "fixture-session")
      const replacement = await runtime.fork("fixture-entry", "at")
      assert.equal(replacement.sourceSessionId, "fixture-session")
      assert.equal(runtime.getSessionId(), replacement.targetSessionId)
      // The fixture rejects requests whose sessionId does not match its current
      // session, so this only succeeds when the client tracks the replacement.
      assert.equal((await runtime.listCommands())[0]?.name, "fixture-command")
    } finally {
      await runtime.dispose()
    }
  })

  it("coordinates an extension replacement through host calls", async () => {
    const runtime = await PiWorkerSession.open("/fixture", "/fixture/session.jsonl", fixture)
    const calls: string[] = []
    const replacements: string[] = []
    runtime.setHostCallHandler(call => { calls.push(call.type) })
    const unsubscribe = runtime.onSessionReplacement(replacement => {
      replacements.push(replacement.targetSessionId)
    })
    try {
      await runtime.prompt("extension-new-session")
      assert.deepEqual(calls, ["extensionReplacement.reserve", "extensionReplacement.commit"])
      assert.deepEqual(replacements, [runtime.getSessionId()])
      assert.match(runtime.getSessionId(), /^fixture-extension-/)
      assert.equal((await runtime.listCommands())[0]?.name, "fixture-command")
    } finally {
      unsubscribe()
      await runtime.dispose()
    }
  })

  it("removes synthetic timeline ids when a bounded delta reconciles native entries", async () => {
    const runtime = await PiWorkerSession.open("/fixture", "/fixture/session.jsonl", fixture)
    try {
      const ids: string[][] = []
      const unsubscribe = runtime.onProjection(projection => {
        ids.push(projection.timeline.map(item => item.id))
      })
      await runtime.prompt("reconcile")
      unsubscribe()
      assert.equal(ids.some(value => value.length === 1 && value[0] === "synthetic-entry"), true)
      assert.equal(ids.some(value => value.length === 1 && value[0] === "native-entry"), true)
      assert.equal(ids.some(value => value.includes("synthetic-entry") && value.includes("native-entry")), false)
      assert.deepEqual(runtime.getProjection().timeline.map(item => item.id), ["native-entry"])
    } finally {
      await runtime.dispose()
    }
  })

  it("rejects pending commands when the worker crashes", async () => {
    const runtime = await PiWorkerSession.open("/fixture", "/fixture/session.jsonl", fixture)
    await assert.rejects(runtime.prompt("crash"), /exited unexpectedly/)
    await runtime.dispose()
  })

  it("keeps a pending command alive while heartbeats continue", async () => {
    const runtime = await PiWorkerSession.open("/fixture", "/fixture/session.jsonl", fixture, {
      heartbeatTimeoutMs: 60,
    })
    try {
      await runtime.prompt("wait")
    } finally {
      await runtime.dispose()
    }
  })

  it("terminates a worker after missed heartbeats", async () => {
    const runtime = await PiWorkerSession.open("/fixture", "/fixture/session.jsonl", fixture, {
      heartbeatTimeoutMs: 60,
    })
    let crashes = 0
    runtime.onCrash?.(() => { crashes += 1 })
    await assert.rejects(runtime.prompt("hang"), error => {
      assert.equal((error as { code?: string }).code, "WORKER_HEARTBEAT_TIMEOUT")
      return true
    })
    assert.equal(crashes, 1)
    await runtime.dispose()
  })

  it("ignores events from another worker generation", async () => {
    const runtime = await PiWorkerSession.open("/fixture", "/fixture/session.jsonl", fixture)
    try {
      let ticks = 0
      const unsubscribe = runtime.onProjection(() => { ticks += 1 })
      await runtime.prompt("stale")
      unsubscribe()
      assert.equal(ticks, 1)
      assert.equal(runtime.getProjection().timeline.length, 0)
    } finally {
      await runtime.dispose()
    }
  })

  it("does not report a graceful dispose as a crash", async () => {
    const runtime = await PiWorkerSession.open("/fixture", "/fixture/session.jsonl", fixture)
    let crashes = 0
    runtime.onCrash?.(() => { crashes += 1 })
    await runtime.dispose()
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    assert.equal(crashes, 0)
  })
})
