import assert from "node:assert/strict"
import test from "node:test"
import { EventHub } from "../event-hub.ts"
import type { WorkerSession } from "./worker-client.ts"
import type { RuntimeSupervisor } from "./supervisor.ts"
import { SessionHost } from "./session-host.ts"

test("SessionHost rejects reopening a runtime while it is closing", async () => {
  let releaseAbort!: () => void
  let opens = 0
  const worker = {
    command: async (type: string) => {
      if (type === "abort") return new Promise<void>(resolve => { releaseAbort = resolve })
      return {}
    },
    getSessionId: () => "session-1",
    getSessionFile: () => "session-1.jsonl",
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    open: async () => {
      opens += 1
      return worker
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())

  await host.openSession(".", "session-1.jsonl")
  const closing = host.closeSession("session-1")
  await assert.rejects(host.openSession(".", "session-1.jsonl"), { code: "RUNTIME_CLOSING" })

  releaseAbort()
  await closing
  await host.openSession(".", "session-1.jsonl")
  assert.equal(opens, 2)
})

test("SessionHost retries a busy self-heal attach", async () => {
  let opens = 0
  const worker = {
    command: async (type: string) => type === "tree.get" ? [{ id: "root" }] : {},
    getSessionId: () => "session-1",
    getSessionFile: () => "session-1.jsonl",
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    catalogCommand: async () => [{ id: "session-1", path: "session-1.jsonl", cwd: "." }],
    open: async () => {
      opens += 1
      if (opens === 1) throw Object.assign(new Error("lock is busy"), { code: "SESSION_BUSY" })
      return worker
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())

  assert.deepEqual(await host.sessionQuery("session-1", "tree.get"), [{ id: "root" }])
  assert.equal(opens, 2)
  host.dispose()
})

test("SessionHost reuses an idle runtime for a session switch", async () => {
  let opens = 0
  const worker = {
    command: async (type: string) => {
      if (type === "switchSession") {
        return {
          operation: "switch",
          sourceSessionId: "session-1",
          targetSessionId: "session-2",
          targetSessionFile: "session-2.jsonl",
          targetCwd: ".",
          cancelled: false,
        }
      }
      if (type === "state.get") return { sessionId: "session-2" }
      return {}
    },
    getSessionId: () => "session-1",
    getSessionFile: () => "session-1.jsonl",
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    open: async () => {
      opens += 1
      return worker
    },
    replaceRuntimeLease: async () => {},
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())

  await host.openSession(".", "session-1.jsonl")
  const opened = await host.openSession(".", "session-2.jsonl", undefined, "session-1")

  assert.equal(opens, 1)
  assert.equal(opened.sessionId, "session-2")
  assert.equal(host.getAttached("session-1"), undefined)
  assert.equal(host.getAttached("session-2")?.sessionFile, "session-2.jsonl")
  host.dispose()
})

test("SessionHost claims a warm runtime and replenishes the slot", async () => {
  let opened = 0
  let prewarmed = 0
  let claimed = false
  const worker = {
    command: async (type: string) => type === "state.get" ? { sessionId: "warm-session" } : {},
    getSessionId: () => "warm-session",
    getSessionFile: () => "warm-session.jsonl",
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    open: async () => {
      opened += 1
      return worker
    },
    takeWarmRuntime: async () => {
      if (claimed) return undefined
      claimed = true
      return worker
    },
    prewarm: async () => {
      prewarmed += 1
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())

  const result = await host.openSession(".")

  assert.equal(result.sessionId, "warm-session")
  assert.equal(opened, 0)
  assert.equal(prewarmed, 1)
  assert.equal(host.getAttached("warm-session")?.sessionFile, "warm-session.jsonl")
  host.dispose()
})

test("SessionHost routes extension commands by name through the runtime registry", async () => {
  const executed: Array<{ type: string; params?: unknown }> = []
  const worker = {
    command: async (type: string, params?: unknown) => {
      if (type === "registry.get") {
        return {
          sdkVersion: "0.84.0",
          tools: [],
          activeTools: [],
          commands: [{ name: "my-ext-command", description: "extension command" }],
          extensions: [],
          eventHandlers: [],
        }
      }
      if (type === "state.get") return {}
      executed.push({ type, params })
      return { ok: true }
    },
    getSessionId: () => "session-1",
    getSessionFile: () => "session-1.jsonl",
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    open: async () => worker,
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  await host.openSession(".", "session-1.jsonl")

  const submitted = await host.executeSessionCommand("session-1", "my-ext-command", { args: "hello" }) as { promise: Promise<unknown> }
  await submitted.promise
  assert.deepEqual(executed, [{ type: "my-ext-command", params: { args: "hello" } }])

  // 注册表里没有的命令仍然响亮 404，不落到 worker。
  await assert.rejects(
    async () => { await host.executeSessionCommand("session-1", "does.not.exist") },
    { code: "UNKNOWN_COMMAND" },
  )
  assert.deepEqual(executed, [{ type: "my-ext-command", params: { args: "hello" } }])
  host.dispose()
})

test("SessionHost rejects unknown session commands on a cold session without spawning a worker", async () => {
  let opens = 0
  const supervisor = {
    onEvent: () => () => {},
    open: async () => {
      opens += 1
      throw new Error("should not spawn")
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())

  await assert.rejects(
    async () => { await host.executeSessionCommand("cold-session", "my-ext-command") },
    { code: "UNKNOWN_COMMAND" },
  )
  assert.equal(opens, 0)
  host.dispose()
})
