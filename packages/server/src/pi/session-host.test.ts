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

test("SessionHost validates extension tool arguments against Pi's own tool schema", async () => {
  const executed: Array<{ type: string; params?: unknown }> = []
  const worker = {
    command: async (type: string, params?: unknown) => {
      if (type === "registry.get") {
        return {
          sdkVersion: "0.84.0",
          tools: [{
            name: "my-tool",
            description: "extension tool",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          }],
          activeTools: [],
          commands: [],
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

  // 畸形入参：schema 来自 Pi 的工具定义，在 HTTP 边界响亮 400。
  await assert.rejects(
    async () => { await host.executeSessionCommand("session-1", "my-tool", { value: 42 }) },
    { code: "INVALID_REQUEST" },
  )
  assert.deepEqual(executed, [])

  const submitted = await host.executeSessionCommand("session-1", "my-tool", { value: "ok" }) as { promise: Promise<unknown> }
  await submitted.promise
  assert.deepEqual(executed, [{ type: "my-tool", params: { value: "ok" } }])
  host.dispose()
})

test("SessionHost replenishes the warm slot even when adopting it fails", async () => {
  let opened = 0
  let prewarmed = 0
  let claimed = false
  let stateCalls = 0
  const worker = {
    command: async (type: string) => {
      if (type !== "state.get") return {}
      stateCalls += 1
      // 第一次是 adopt 已领走的 warm（抛错），第二次是回退的冷启动（成功）
      if (stateCalls === 1) throw new Error("state.get failed")
      return { sessionId: "cold-session" }
    },
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

  // warm 的 state.get 失败 → adopt 失败 → 回退冷启动；但 warm 已被消费，
  // 必须立即补预热，保证下一个会话仍是热启动。
  await host.openSession(".")

  assert.equal(claimed, true)
  assert.equal(prewarmed, 1)
  assert.equal(opened, 1)
  // 回退冷启动成功：attach 用的是 worker.getSessionId()
  assert.equal(host.getAttached("warm-session")?.sessionId, "warm-session")
  host.dispose()
})

test("SessionHost prewarms a workspace after reaping its idle runtime", async () => {
  let prewarmed = 0
  const worker = {
    command: async (type: string) => type === "state.get" ? { sessionId: "idle-session" } : {},
    getSessionId: () => "idle-session",
    getSessionFile: () => "idle-session.jsonl",
    getCwd: () => "/workspace",
    updateSessionIdentity: () => {},
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    open: async () => worker,
    prewarm: async () => {
      prewarmed += 1
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  await host.openSession("/workspace", "idle-session.jsonl")

  // 把 lastAccess 改成过去，让 reaper 判定该会话空闲
  const lastAccess = (host as unknown as { lastAccess: Map<string, number> }).lastAccess
  lastAccess.set("idle-session", Date.now() - 10 * 60_000)

  try {
    // reaper 每 30s 跑一次，直接触发内部回收逻辑
    const reap = (host as unknown as { reapIdleRuntimes(): Promise<void> }).reapIdleRuntimes
    await reap.call(host)
  } finally {
    delete process.env.PIUI_SESSION_IDLE_TTL_MS
  }

  assert.equal(host.getAttached("idle-session"), undefined)
  // 回收后补了预热
  assert.equal(prewarmed, 1)
  host.dispose()
})
