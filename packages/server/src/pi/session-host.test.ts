import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventHub } from "../event-hub.ts"
import { getDriverMode } from "@piui/pi-worker"
import type { WorkerSession } from "./worker-client.ts"
import type { RuntimeSupervisor } from "./supervisor.ts"
import { SessionHost } from "./session-host.ts"

test("SessionHost notifies the session list when the session file materializes on disk", async () => {
  const sessionFile = join(tmpdir(), `piui-session-host-${randomUUID()}.jsonl`)
  let emitEvent!: (event: { channel: string; head?: unknown }) => void
  const worker = {
    command: async () => ({}),
    getSessionId: () => "session-1",
    getSessionFile: () => sessionFile,
    getCwd: () => ".",
    updateSessionIdentity: () => {},
    onEvent: (listener: (event: { channel: string; head?: unknown }) => void) => {
      emitEvent = listener
      return () => {}
    },
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    open: async () => worker,
  } as unknown as RuntimeSupervisor
  const hub = new EventHub()
  const host = new SessionHost(supervisor, hub)

  const updated: unknown[] = []
  const off = hub.subscribe(event => {
    if (event.channel === "sessions.updated") updated.push(event.payload)
  })

  await host.openSession(".", sessionFile)
  // attach 会发一条 attached；清掉，只观察 head 推进的通知
  updated.length = 0
  // head 但文件未落盘（setSessionName 等只改内存）：不是 materialized，
  // 列表磁盘扫描看不到它——不能广播，否则前端重拉后列表永远不出现。
  emitEvent({ channel: "session.head", head: { revision: 1, entryCount: 1 } })
  assert.equal(updated.length, 0)

  // 文件首次落盘 + head：materialized 必发（列表可扫到）
  writeFileSync(sessionFile, '{"type":"session","version":1}\n')
  emitEvent({ channel: "session.head", head: { revision: 2, entryCount: 2 } })
  assert.equal(updated.length, 1)
  assert.deepEqual(updated[0], {
    sessionId: "session-1",
    materialized: true,
  })

  // 原生语义：后续 head 推进（新消息）不再广播列表事件——列表 = 磁盘扫描，
  // 文件已存在，重扫结果不会变；排序/消息数由下一次生命周期事件或显式
  // 刷新时更新。
  emitEvent({ channel: "session.head", head: { revision: 3 } })
  emitEvent({ channel: "session.head", head: { revision: 4, entryCount: 4 } })
  assert.equal(updated.length, 1)

  off()
  host.dispose()
  rmSync(sessionFile, { force: true })
})

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

test("SessionHost reaps an idle runtime without prewarming", async () => {
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
    dispose: async () => {
      // 句柄 dispose = session.close（关 runtime，不杀进程）
    },
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
  // 单共享进程架构：回收后不再补预热（worker 常驻，无需预热进程）
  assert.equal(prewarmed, 0)
  host.dispose()
})

test("SessionHost piRegistry falls back to the static snapshot while the worker is booting", async () => {
  let catalogCalled = false
  const supervisor = {
    onEvent: () => () => {},
    peekCatalogHandshake: async () => undefined,
    catalogCommand: async () => {
      catalogCalled = true
      throw new Error("worker must not be queried before it is ready")
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  try {
    const registry = await host.piRegistry()
    assert.equal(catalogCalled, false)
    assert.equal(registry.driver, getDriverMode())
    const names = new Set([
      ...registry.globalCommands.map(command => command.name),
      ...registry.sessionCommands.map(command => command.name),
    ])
    // server 注入的能力 + 静态命令表的核心命令必须都在
    for (const required of ["session.open", "session.attached", "session.listAll", "state.get", "prompt", "abort", "registry.get", "registry.describe"]) {
      assert.ok(names.has(required), `missing capability: ${required}`)
    }
  } finally {
    host.dispose()
  }
})

test("SessionHost piRegistry uses the worker snapshot once the handshake is ready", async () => {
  const supervisor = {
    onEvent: () => () => {},
    peekCatalogHandshake: async () => ({ piSdkVersion: "9.9.9", piSdkVerified: false }),
    catalogCommand: async (type: string) => {
      assert.equal(type, "registry.describe")
      return {
        protocolVersion: 1,
        revision: 7,
        sdkVersion: "9.9.9",
        driver: "pi",
        globalCommands: [{ name: "registry.describe", scope: "global", source: "piui-adapter", description: "", paramsSchema: { type: "object" }, queue: "immediate" }],
        sessionCommands: [],
      }
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())
  try {
    const registry = await host.piRegistry()
    assert.equal(registry.sdkVersion, "9.9.9")
    assert.equal(registry.revision, 7)
    // server 能力仍合并进来
    assert.ok(registry.globalCommands.some(command => command.name === "session.open"))
    assert.ok(registry.sessionCommands.some(command => command.name === "session.close"))
  } finally {
    host.dispose()
  }
})
