import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { applyWorkerEvent, createProjectionState, runMockTurn, type PiSessionRuntime } from "@piui/pi-worker"
import { SessionRegistry, type PiSessionBackend } from "./session-registry.ts"
import { WorkspaceStore } from "./workspace-store.ts"
import { EventHub } from "./event-hub.ts"

describe("native Pi session discovery", () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-native-session-"))
  after(() => rmSync(root, { recursive: true, force: true }))

  it("uses the Pi session id and opens only the server-discovered file", async () => {
    const projection = createProjectionState()
    const runtime = {
      getSessionId: () => "pi-native-id",
      getSessionFile: () => path.join(root, "native.jsonl"),
      getSessionName: () => "Native session",
      getProjection: () => projection,
    } as unknown as PiSessionRuntime
    const opened: Array<{ cwd: string; sessionFile?: string }> = []
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-native-id",
        path: path.join(root, "native.jsonl"),
        cwd: root,
        name: "Native session",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 2,
        firstMessage: "hello",
      }],
      open: async (cwd, sessionFile) => {
        opened.push({ cwd, sessionFile })
        return runtime
      },
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)

    const listed = await registry.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.id, "pi-native-id")
    assert.equal(listed[0]?.driverSessionId, "pi-native-id")
    assert.equal(listed[0]?.real, undefined)

    const attached = await registry.attach("pi-native-id")
    assert.equal(attached.real, runtime)
    assert.deepEqual(opened, [{ cwd: root, sessionFile: path.join(root, "native.jsonl") }])
  })

  it("deduplicates concurrent runtime attachment", async () => {
    const projection = createProjectionState()
    const runtime = {
      getSessionId: () => "pi-concurrent-id",
      getSessionFile: () => path.join(root, "concurrent.jsonl"),
      getSessionName: () => undefined,
      getProjection: () => projection,
    } as unknown as PiSessionRuntime
    let opens = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-concurrent-id",
        path: path.join(root, "concurrent.jsonl"),
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => {
        opens += 1
        await gate
        return runtime
      },
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)
    await registry.list()

    const first = registry.attach("pi-concurrent-id")
    const second = registry.attach("pi-concurrent-id")
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(opens, 1)
    release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.real, runtime)
    assert.equal(b.real, runtime)
  })

  it("disposes a runtime that finishes opening after its session was deleted", async () => {
    const projection = createProjectionState()
    let disposals = 0
    const runtime = {
      getSessionId: () => "pi-delete-during-open",
      getSessionFile: () => path.join(root, "delete-during-open.jsonl"),
      getSessionName: () => undefined,
      getProjection: () => projection,
      dispose: async () => { disposals += 1 },
    } as unknown as PiSessionRuntime
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-delete-during-open",
        path: path.join(root, "delete-during-open.jsonl"),
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => {
        await gate
        return runtime
      },
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)
    await registry.list()
    const attaching = registry.attach("pi-delete-during-open")
    void attaching.catch(() => undefined)
    await new Promise<void>(resolve => setImmediate(resolve))
    const deleting = registry.delete("pi-delete-during-open")
    release()

    assert.equal(await deleting, true)
    await assert.rejects(attaching, error => {
      assert.equal((error as { code?: string }).code, "SESSION_NOT_FOUND")
      return true
    })
    assert.equal(disposals, 1)
    assert.equal(registry.get("pi-delete-during-open"), undefined)
  })

  it("deduplicates concurrent and recent discovery scans", async () => {
    let scans = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const backend: PiSessionBackend = {
      listAll: async () => {
        scans += 1
        await gate
        return []
      },
      open: async () => { throw new Error("not used") },
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)

    const first = registry.warmup()
    const second = registry.list()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(scans, 1)
    release()
    await Promise.all([first, second])
    await registry.list()
    assert.equal(scans, 1)
  })

  it("uses Pi scoped listing when a workspace is known", async () => {
    const workspaces = new WorkspaceStore()
    const workspace = workspaces.register(root)
    let scopedCwd: string | undefined
    const backend: PiSessionBackend = {
      list: async cwd => {
        scopedCwd = cwd
        return []
      },
      listAll: async () => { throw new Error("global scan should not run") },
      open: async () => { throw new Error("not used") },
    }
    const registry = new SessionRegistry(workspaces, "pi", backend)

    await registry.list(workspace.id)
    assert.equal(scopedCwd, workspace.canonicalRoot)
  })

  it("records worker generation and publishes runtime replacement and crash", async () => {
    const projection = { ...createProjectionState(), isStreaming: true }
    let crash: ((error: Error) => void) | undefined
    const runtime = {
      getWorkerGeneration: () => "worker-generation-1",
      onCrash: (listener: (error: Error) => void) => {
        crash = listener
        return () => { crash = undefined }
      },
      getSessionId: () => "pi-lifecycle-id",
      getSessionFile: () => path.join(root, "lifecycle.jsonl"),
      getSessionName: () => "Lifecycle session",
      getProjection: () => projection,
      getRuntimeUiState: () => ({
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        isStreaming: false,
        isCompacting: false,
        retryAttempt: 0,
        queue: { steering: [], followUp: [] },
        activeTools: [],
      }),
      getModel: () => undefined,
      getThinkingLevel: () => "off",
      getAvailableThinkingLevels: () => ["off"],
      isStreaming: () => false,
      getLeafId: () => null,
      getEntries: () => [],
      getTree: () => [],
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-lifecycle-id",
        path: path.join(root, "lifecycle.jsonl"),
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => runtime,
    }
    const eventHub = new EventHub()
    const eventTypes: string[] = []
    eventHub.subscribeV2(event => eventTypes.push(event.type))
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend, eventHub)
    await registry.list()

    const attached = await registry.attach("pi-lifecycle-id")
    assert.equal(registry.snapshot(attached).runtime.workerGeneration, "worker-generation-1")
    assert.deepEqual(eventTypes, ["session.runtime.replaced", "session.snapshot.updated"])

    assert.ok(crash)
    crash(new Error("worker stopped"))
    assert.equal(registry.snapshot(attached).session.state, "crashed")
    assert.equal(registry.snapshot(attached).runtime.runtimeError, "worker stopped")
    assert.equal(registry.snapshot(attached).runtime.isStreaming, false)
    assert.equal(attached.real, undefined)
    assert.deepEqual(eventTypes, [
      "session.runtime.replaced",
      "session.snapshot.updated",
      "session.runtime.crashed",
      "session.snapshot.updated",
    ])
  })

  it("rejects delayed callbacks from a crashed worker generation", async () => {
    const initialProjection = createProjectionState()
    let staleProjection = initialProjection
    for (const event of runMockTurn({ userText: "stale", assistantText: "stale reply" })) {
      staleProjection = applyWorkerEvent(staleProjection, event)
    }
    let crashFirst!: (error: Error) => void
    let staleTick: ((projection: typeof staleProjection) => void) | undefined
    let releasePrompt!: () => void
    const promptGate = new Promise<void>(resolve => { releasePrompt = resolve })
    let secondState!: () => void
    const runtimeState = {
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      isStreaming: false,
      isCompacting: false,
      retryAttempt: 0,
      queue: { steering: [], followUp: [] },
      activeTools: [],
    }
    const common = {
      getSessionId: () => "pi-generation-id",
      getSessionFile: () => path.join(root, "generation.jsonl"),
      getSessionName: () => "Generation session",
      getRuntimeUiState: () => runtimeState,
      getModel: () => undefined,
      getThinkingLevel: () => "off",
      getAvailableThinkingLevels: () => ["off"],
      isStreaming: () => false,
      getLeafId: () => null,
      getEntries: () => [],
      getTree: () => [],
      dispose: async () => {},
    }
    const first = {
      ...common,
      getWorkerGeneration: () => "generation-1",
      getProjection: () => initialProjection,
      onState: () => () => {},
      onCrash: (listener: (error: Error) => void) => {
        crashFirst = listener
        return () => {}
      },
      prompt: async (_text: string, onTick?: (projection: typeof staleProjection) => void) => {
        staleTick = onTick
        await promptGate
      },
    } as unknown as PiSessionRuntime
    const second = {
      ...common,
      getWorkerGeneration: () => "generation-2",
      getProjection: () => initialProjection,
      onState: (listener: () => void) => {
        listener()
        secondState = listener
        return () => {}
      },
      onCrash: () => () => {},
    } as unknown as PiSessionRuntime
    let opens = 0
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-generation-id",
        path: path.join(root, "generation.jsonl"),
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => (++opens === 1 ? first : second),
    }
    const runtimeCrashes: string[] = []
    const registry = new SessionRegistry(
      new WorkspaceStore(),
      "pi",
      backend,
      new EventHub(),
      (_sessionId, generation) => runtimeCrashes.push(generation ?? ""),
    )
    await registry.list()
    const running = registry.prompt("pi-generation-id", "hello")
    await new Promise<void>(resolve => setImmediate(resolve))

    crashFirst(new Error("generation 1 crashed"))
    const replacement = await registry.attach("pi-generation-id")
    assert.equal(replacement.workerGeneration, "generation-2")
    const replacementSequence = replacement.sequence
    staleTick?.(staleProjection)
    releasePrompt()
    await assert.rejects(running, error => {
      assert.equal((error as { code?: string }).code, "SESSION_RUNTIME_CRASHED")
      return true
    })
    assert.equal(replacement.real, second)
    assert.equal(replacement.sequence, replacementSequence)
    assert.equal(replacement.projection.timeline.length, 0)
    assert.deepEqual(runtimeCrashes, ["generation-1"])

    secondState()
    assert.equal(replacement.sequence, replacementSequence + 1)
  })
})
