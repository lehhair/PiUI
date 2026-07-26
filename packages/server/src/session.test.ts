import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { createProjectionState, type PiSessionRuntime } from "@piui/pi-worker"
import { createAppServer } from "./http.ts"
import { EventHub } from "./event-hub.ts"
import type { PiSessionBackend } from "./session-registry.ts"
import { RuntimeSupervisor } from "./runtime-supervisor.ts"
import { SessionLeaseManager } from "./session-lease.ts"

const workerFixture = new URL("./pi-worker-fixture.mjs", import.meta.url)

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()))
  })
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("no port")
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(e => (e ? reject(e) : resolve()))
      }),
  }
}

async function json(port: number, method: string, urlPath: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json() }
}

async function waitForCommand(port: number, commandId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await json(port, "GET", `/api/v1/commands/${commandId}`)
    const status = response.data.command?.status as string | undefined
    if (status && status !== "accepted" && status !== "running") return response
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`command ${commandId} did not finish`)
}

async function waitFor(check: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return false
}

describe("session mock snapshot (no LLM)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-sess-"))
  after(() => rmSync(root, { recursive: true, force: true }))

  it("dev mock-chat seeds workspace + snapshot", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const res = await json(port, "POST", "/api/v1/dev/mock-chat")
      assert.equal(res.status, 201)
      assert.ok(res.data.workspace.id)
      assert.ok(res.data.snapshot.timeline.length >= 2)
    } finally {
      await close()
    }
  })

  it("create empty session, list, delete", async () => {
    const eventHub = new EventHub()
    const workspaceEvents: string[] = []
    eventHub.subscribeV2(event => {
      if (event.type === "workspace.sessions.updated") workspaceEvents.push(event.payload.sessionId ?? "")
    })
    const server = createAppServer({ eventHub })
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/sessions", { title: "blank" })
      assert.equal(created.status, 201)
      assert.equal(created.data.snapshot.timeline.length, 0)
      const id = created.data.session.id as string
      assert.equal(created.data.snapshot.session.driverSessionId, id)
      assert.deepEqual(workspaceEvents, [id])

      const listed = await json(port, "GET", "/api/v1/sessions")
      assert.equal(listed.status, 200)
      const listedSession = (listed.data.sessions as { id: string; directory?: string }[]).find(s => s.id === id)
      assert.ok(listedSession)
      assert.equal(typeof listedSession.directory, "string")
      assert.equal((listedSession as { state?: string }).state, "idle")

      const del = await json(port, "DELETE", `/api/v1/sessions/${id}`)
      assert.equal(del.status, 200)
      assert.deepEqual(workspaceEvents, [id, id])
      const listed2 = await json(port, "GET", "/api/v1/sessions")
      assert.ok(!(listed2.data.sessions as { id: string }[]).some(s => s.id === id))
    } finally {
      await close()
    }
  })

  it("does not share in-memory sessions across server instances", async () => {
    const firstServer = createAppServer()
    const first = await listen(firstServer)
    try {
      const created = await json(first.port, "POST", "/api/v1/sessions", { title: "first server" })
      assert.equal(created.status, 201)
    } finally {
      await first.close()
    }

    const secondServer = createAppServer()
    const second = await listen(secondServer)
    try {
      const listed = await json(second.port, "GET", "/api/v1/sessions")
      assert.equal(listed.status, 200)
      assert.deepEqual(listed.data.sessions, [])
    } finally {
      await second.close()
    }
  })

  it("prompt appends mock turn without LLM", async () => {
    const eventHub = new EventHub()
    const snapshots: Array<{ reason: string; snapshot: { sequence: number; session: { title?: string } } }> = []
    eventHub.subscribeV2(event => {
      if (event.type === "session.snapshot.updated") snapshots.push(event.payload)
    })
    const server = createAppServer({ eventHub })
    const { port, close } = await listen(server)
    try {
      const seeded = await json(port, "POST", "/api/v1/dev/mock-chat")
      const sessionId = seeded.data.snapshot.session.id as string
      const before = seeded.data.snapshot.timeline.length as number

      const prompted = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/prompt`, {
        text: "second turn",
        stream: true,
      })
      assert.equal(prompted.status, 202)
      assert.equal(prompted.data.accepted, true)
      assert.equal(await waitFor(async () => snapshots.some(item => item.snapshot.session.title === "second turn")), true)
      assert.equal(snapshots[0]?.snapshot.session.title, "second turn")
      await waitForCommand(port, prompted.data.commandId)
      const completed = await json(port, "GET", `/api/v1/sessions/${sessionId}/snapshot`)
      const after = completed.data.timeline as { type: string; text?: string }[]
      assert.ok(after.length > before)
      const lastUser = [...after].reverse().find(t => t.type === "user")
      assert.equal(lastUser?.text, "second turn")
      const lastAsst = [...after].reverse().find(t => t.type === "assistant")
      assert.ok(lastAsst)
      assert.equal(snapshots.at(-1)?.reason, "command")
      assert.equal(snapshots.at(-1)?.snapshot.sequence, completed.data.sequence)
      assert.equal(snapshots.at(-1)?.snapshot.session.title, "second turn")
    } finally {
      await close()
    }
  })

  it("returns native commands and skills as arrays", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/sessions", { title: "commands" })
      const sessionId = created.data.session.id as string
      const commands = await json(port, "GET", `/api/v1/sessions/${sessionId}/pi/commands`)
      const skills = await json(port, "GET", `/api/v1/sessions/${sessionId}/pi/skills`)
      assert.equal(commands.status, 200)
      assert.ok(Array.isArray(commands.data.commands))
      assert.equal(skills.status, 200)
      assert.ok(Array.isArray(skills.data.skills))
    } finally {
      await close()
    }
  })

  it("increments snapshot sequence for runtime state changes", async () => {
    const eventHub = new EventHub()
    const commandSnapshots: number[] = []
    eventHub.subscribeV2(event => {
      if (event.type === "session.snapshot.updated" && event.payload.reason === "command") {
        commandSnapshots.push(event.payload.snapshot.sequence)
      }
    })
    const server = createAppServer({ eventHub })
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/sessions", { title: "sequence" })
      const sessionId = created.data.session.id as string
      const before = created.data.snapshot.sequence as number
      const changed = await json(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/commands/set-thinking-level`,
        { level: "high" },
      )
      assert.equal(changed.status, 200)
      assert.equal(changed.data.snapshot.sequence, before + 1)
      assert.deepEqual(commandSnapshots, [changed.data.snapshot.sequence])
    } finally {
      await close()
    }
  })

  it("reuses a prompt commandId without executing the turn twice", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/sessions", { title: "idempotent" })
      const sessionId = created.data.session.id as string
      const body = { text: "only once", commandId: "prompt-once" }

      const first = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/prompt`, body)
      const second = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/prompt`, body)
      assert.equal(first.status, 202)
      assert.equal(second.status, 202)
      assert.equal(second.data.reused, true)
      await waitForCommand(port, "prompt-once")
      const snapshot = await json(port, "GET", `/api/v1/sessions/${sessionId}/snapshot`)
      const users = (snapshot.data.timeline as Array<{ type: string; text?: string }>)
        .filter(item => item.type === "user" && item.text === "only once")
      assert.equal(users.length, 1)

      const command = await json(port, "GET", "/api/v1/commands/prompt-once")
      assert.equal(command.status, 200)
      assert.equal(command.data.command.status, "completed")
    } finally {
      await close()
    }
  })

  it("marks a crashed prompt unknown and does not replay it", async () => {
    const projection = createProjectionState()
    let crash: ((error: Error) => void) | undefined
    let opens = 0
    const runtimeState = {
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      isStreaming: false,
      isCompacting: false,
      isIdle: true,
      queue: { steering: [], followUp: [] },
      retryAttempt: 0,
      activeTools: [],
      supportsThinking: false,
    }
    const runtime = {
      getWorkerGeneration: () => "crash-generation",
      onCrash: (listener: (error: Error) => void) => {
        crash = listener
        return () => { crash = undefined }
      },
      onState: (listener: (state: typeof runtimeState) => void) => {
        listener(runtimeState)
        return () => {}
      },
      getProjection: () => projection,
      getSessionId: () => "crash-session",
      getSessionFile: () => path.join(root, "crash-session.jsonl"),
      getSessionName: () => "Crash session",
      getEntries: () => [],
      getTree: () => [],
      getLeafId: () => null,
      getModel: () => undefined,
      getThinkingLevel: () => "off",
      getAvailableThinkingLevels: () => ["off"],
      isStreaming: () => false,
      getRuntimeUiState: () => runtimeState,
      prompt: async () => {
        crash?.(new Error("fixture worker crashed"))
        throw new Error("worker exited")
      },
      dispose: async () => {},
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "crash-session",
        path: path.join(root, "crash-session.jsonl"),
        cwd: root,
        name: "Crash session",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => {
        opens += 1
        return runtime
      },
    }
    const server = createAppServer({ driver: "pi", piBackend: backend })
    const { port, close } = await listen(server)
    try {
      const prompted = await json(port, "POST", "/api/v1/sessions/crash-session/commands/prompt", {
        text: "do not replay",
        commandId: "crash-command",
      })
      assert.equal(prompted.status, 202)
      const command = await waitForCommand(port, "crash-command")
      assert.equal(command.data.command.status, "unknown_after_crash")
      assert.equal(opens, 1)
    } finally {
      await close()
    }
  })

  it("creates session with projected timeline", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const ws = await json(port, "POST", "/api/v1/workspaces", { rootPath: root })
      assert.equal(ws.status, 201)
      const workspaceId = ws.data.workspace.id as string

      const created = await json(port, "POST", "/api/v1/sessions", {
        workspaceId,
        title: "demo",
        seedMock: true,
      })
      assert.equal(created.status, 201)
      const snap = created.data.snapshot
      assert.equal(snap.protocolVersion, 1)
      assert.equal(snap.session.driverId, "pi")
      assert.ok(Array.isArray(snap.timeline))
      assert.ok(snap.timeline.length >= 2)
      assert.equal(snap.timeline[0].type, "user")
      assert.equal(snap.timeline[1].type, "assistant")
      const tool = snap.timeline[1].content.find((c: { type: string }) => c.type === "tool")
      assert.ok(tool)
      assert.equal(tool.status, "completed")

      const sessionId = snap.session.id as string
      const again = await json(port, "GET", `/api/v1/sessions/${sessionId}/snapshot`)
      assert.equal(again.status, 200)
      assert.equal(again.data.session.id, sessionId)
      assert.equal(again.data.timeline.length, snap.timeline.length)
    } finally {
      await close()
    }
  })

  it("routes native tree, metadata, and fork commands through HTTP", async () => {
    const backend = new RuntimeSupervisor({
      workerEntry: workerFixture,
      leases: new SessionLeaseManager(path.join(root, "r3-http-leases")),
    })
    const server = createAppServer({ driver: "pi", piBackend: backend })
    const { port, close } = await listen(server)
    try {
      const workspace = await json(port, "POST", "/api/v1/workspaces", { rootPath: root })
      const created = await json(port, "POST", "/api/v1/sessions", {
        workspaceId: workspace.data.workspace.id,
      })
      assert.equal(created.status, 201)
      const sourceId = created.data.snapshot.session.id as string
      assert.equal(created.data.snapshot.native.entries[0]?.type, "message")
      assert.equal(created.data.snapshot.native.tree[0]?.entry.id, "fixture-entry")

      const navigated = await json(
        port,
        "POST",
        `/api/v1/sessions/${sourceId}/commands/navigate-tree`,
        { entryId: "fixture-entry" },
      )
      assert.equal(navigated.status, 200)
      assert.equal(navigated.data.editorText, "fixture draft")

      const labeled = await json(port, "POST", `/api/v1/sessions/${sourceId}/commands/set-label`, {
        entryId: "fixture-entry",
        label: "checkpoint",
      })
      assert.equal(labeled.data.snapshot.native.tree[0].label, "checkpoint")

      const renamed = await json(port, "POST", `/api/v1/sessions/${sourceId}/commands/set-name`, {
        name: "R3 session",
      })
      assert.equal(renamed.data.snapshot.session.title, "R3 session")

      const forked = await json(port, "POST", `/api/v1/sessions/${sourceId}/commands/fork`, {
        entryId: "fixture-entry",
        position: "at",
      })
      assert.equal(forked.status, 200)
      assert.equal(forked.data.sourceSnapshot.session.id, sourceId)
      assert.notEqual(forked.data.targetSnapshot.session.id, sourceId)
      assert.equal(forked.data.replacement.cancelled, false)
      assert.equal(forked.data.command.status, "completed")

      const forkTargetId = forked.data.targetSnapshot.session.id as string
      const cloned = await json(port, "POST", `/api/v1/sessions/${forkTargetId}/commands/clone`, {
        entryId: "fixture-entry",
      })
      assert.equal(cloned.status, 200)
      assert.notEqual(cloned.data.targetSnapshot.session.id, forkTargetId)

      const cloneTargetId = cloned.data.targetSnapshot.session.id as string
      const imported = await json(port, "POST", `/api/v1/sessions/${cloneTargetId}/commands/import`, {
        inputPath: path.join(root, "import.jsonl"),
        cwdOverride: root,
      })
      assert.equal(imported.status, 200)
      assert.notEqual(imported.data.targetSnapshot.session.id, cloneTargetId)

      const deleted = await json(port, "DELETE", `/api/v1/sessions/${sourceId}`)
      assert.equal(deleted.status, 200)
      assert.equal(deleted.data.command.request.payload.durable, true)
    } finally {
      await close()
    }
  })

  it("routes R4 control, queue, retry, compaction, and tool commands", async () => {
    const backend = new RuntimeSupervisor({
      workerEntry: workerFixture,
      leases: new SessionLeaseManager(path.join(root, "r4-http-leases")),
    })
    const server = createAppServer({ driver: "pi", piBackend: backend })
    const { port, close } = await listen(server)
    try {
      const health = await json(port, "GET", "/api/v1/health")
      assert.equal(health.data.protocolV2.capabilities.capabilities["prompt.steer"].enabled, true)
      assert.equal(health.data.protocolV2.capabilities.capabilities["tools.manage"].enabled, true)
      assert.equal(health.data.protocolV2.capabilities.capabilities["prompt.multimodal"].enabled, true)
      assert.equal(health.data.protocolV2.capabilities.capabilities["bash.user"].enabled, true)
      assert.equal(health.data.protocolV2.capabilities.capabilities["session.export"].enabled, true)
      assert.equal(health.data.protocolV2.capabilities.capabilities["resources.reload"].enabled, true)
      assert.equal(health.data.protocolV2.capabilities.capabilities["extension.commands"].enabled, true)
      assert.equal(health.data.capabilities.undo, false)

      const workspace = await json(port, "POST", "/api/v1/workspaces", { rootPath: root })
      const created = await json(port, "POST", "/api/v1/sessions", {
        workspaceId: workspace.data.workspace.id,
      })
      const sessionId = created.data.snapshot.session.id as string

      const prompted = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/prompt`, {
        text: "Use native thinking",
        model: { provider: "fixture", id: "fixture-model" },
        thinkingLevel: "high",
        commandId: "r4-native-thinking",
      })
      assert.equal(prompted.status, 202)
      assert.equal(prompted.data.command.request.payload.thinkingLevel, "high")
      await waitForCommand(port, "r4-native-thinking")
      const configured = await json(port, "GET", `/api/v1/sessions/${sessionId}/snapshot`)
      assert.equal(configured.data.runtime.thinkingLevel, "high")

      const imagePrompt = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/prompt`, {
        text: "Inspect image",
        attachments: [{
          type: "image",
          mimeType: "image/png",
          data: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
        }],
        commandId: "r5-image",
      })
      assert.equal(imagePrompt.status, 202)
      assert.equal((await waitForCommand(port, "r5-image")).data.command.status, "completed")

      const bash = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/bash`, {
        command: "git status",
        excludeFromContext: true,
        commandId: "r5-bash",
      })
      assert.equal(bash.status, 202)
      const bashCommand = await waitForCommand(port, "r5-bash")
      assert.deepEqual(bashCommand.data.command.result, {
        output: "fixture bash: git status",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        fullOutputAvailable: false,
      })

      const exported = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/export-jsonl`, {
        outputPath: "exports/session.jsonl",
        commandId: "r5-export",
      })
      assert.equal(exported.status, 202)
      assert.deepEqual((await waitForCommand(port, "r5-export")).data.command.result, {
        format: "jsonl",
        path: "exports/session.jsonl",
      })

      const reloaded = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/reload-resources`, {})
      assert.equal(reloaded.status, 202)
      assert.equal((await waitForCommand(port, reloaded.data.commandId)).data.command.status, "completed")

      const steered = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/steer`, {
        text: "Correct the parser",
        commandId: "r4-steer",
      })
      assert.equal(steered.status, 202)
      assert.equal((await waitForCommand(port, "r4-steer")).data.command.status, "completed")

      const followed = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/follow-up`, {
        text: "Run the tests",
        commandId: "r4-follow-up",
      })
      assert.equal(followed.status, 202)
      await waitForCommand(port, "r4-follow-up")

      const modes = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/set-queue-modes`, {
        steeringMode: "all",
        followUpMode: "all",
      })
      assert.equal(modes.status, 200)
      assert.deepEqual(modes.data.snapshot.runtime.queue, {
        steering: ["Correct the parser"],
        followUp: ["Run the tests"],
        steeringMode: "all",
        followUpMode: "all",
      })

      const tools = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/set-tools`, {
        toolNames: ["read", "bash"],
      })
      assert.deepEqual(tools.data.snapshot.runtime.activeTools, ["read", "bash"])

      const retry = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/set-auto-retry`, {
        enabled: false,
      })
      assert.equal(retry.data.snapshot.runtime.retry.autoEnabled, false)

      const aborted = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/abort`, {})
      assert.deepEqual(aborted.data.cleared, {
        steering: ["Correct the parser"],
        followUp: ["Run the tests"],
      })
      assert.deepEqual(aborted.data.snapshot.runtime.queue.followUp, [])

      await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/follow-up`, {
        text: "After abort",
        commandId: "r4-follow-up-after-abort",
      })
      await waitForCommand(port, "r4-follow-up-after-abort")
      const cleared = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/clear-queue`, {})
      assert.deepEqual(cleared.data.cleared, {
        steering: [],
        followUp: ["After abort"],
      })
      assert.deepEqual(cleared.data.snapshot.runtime.queue.steering, [])

      const compacted = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/compact`, {
        instructions: "wait-for-abort",
        commandId: "r4-compact",
      })
      assert.equal(compacted.status, 202)
      assert.equal(compacted.data.command.request.concurrency, "idle-only")
      const compactStarted = await waitFor(async () => {
        const current = await json(port, "GET", `/api/v1/sessions/${sessionId}/snapshot`)
        assert.equal(current.status, 200, JSON.stringify(current.data))
        return current.data.runtime.compaction.operation.type === "compaction"
      })
      assert.equal(compactStarted, true)
      const stoppedCompaction = await json(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/commands/abort-compaction`,
        {},
      )
      assert.equal(stoppedCompaction.status, 200)
      assert.equal((await waitForCommand(port, "r4-compact")).data.command.status, "completed")
    } finally {
      await close()
    }
  })
})
