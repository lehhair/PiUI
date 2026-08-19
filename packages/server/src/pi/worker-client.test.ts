import assert from "node:assert/strict"
import test from "node:test"
import { WorkerSession, type WorkerCatalog } from "./worker-client.ts"

function startCatalog(mode: string, options: { requestTimeoutMs?: number } = {}): WorkerCatalog {
  return WorkerSession.createCatalog(new URL("./worker-client-fixture.mjs", import.meta.url), {
    env: { PIUI_FIXTURE_MODE: mode },
    execArgv: ["--import", "tsx"],
    requestTimeoutMs: options.requestTimeoutMs ?? 200,
  })
}

test("WorkerSession fulfills a command on a healthy worker", async () => {
  const catalog = startCatalog("hello-ok")
  try {
    const hello = await catalog.getHandshake()
    assert.equal(hello.piSdkVersion, "0.84.0")
    assert.deepEqual(await catalog.command("state.get"), { fixture: "ok" })
  } finally {
    await catalog.dispose()
  }
})

test("WorkerSession kills a worker that stops heartbeating and fails pending commands", async () => {
  const catalog = startCatalog("silent")
  const crashes: Error[] = []
  catalog.onCrash(error => crashes.push(error))
  try {
    await catalog.getHandshake()
    const command = catalog.command("state.get")
    await assert.rejects(command, error => {
      assert.equal((error as { code?: string }).code, "WORKER_RESULT_UNKNOWN")
      return true
    })
    await waitFor(() => crashes.length > 0)
    assert.equal((crashes[0] as { code?: string }).code, "SESSION_RUNTIME_CRASHED")
  } finally {
    await catalog.dispose()
  }
})

test("WorkerSession keeps a healthy worker when only a command times out", async () => {
  // 回归测试：worker 心跳正常（健康），但某条命令永不响应（如模型调用
  // 慢）。命令超时后 worker 必须存活——之前的实现看到 heartbeatMisses>0
  // 就误杀健康 worker（watchdog 与心跳同频相位错开时 misses 恒为 1），
  // 导致所有会话随 worker 一起丢失。
  const catalog = startCatalog("slow-command")
  const crashes: Error[] = []
  catalog.onCrash(error => crashes.push(error))
  try {
    await catalog.getHandshake()
    const command = catalog.command("state.get")
    await assert.rejects(command, error => {
      assert.equal((error as { code?: string }).code, "WORKER_RESULT_UNKNOWN")
      return true
    })
    // 命令超时后：心跳正常（fixture 一直在发），worker 不得被杀。
    // 多等几个心跳周期确认 crash 不会晚到。
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(crashes.length, 0, "healthy worker must not be killed on command timeout")
    // 且 worker 进程仍然存活（后续命令只是再次超时，进程没被杀）
    await assert.rejects(catalog.command("registry.describe"), error => {
      assert.equal((error as { code?: string }).code, "WORKER_RESULT_UNKNOWN")
      return true
    })
    assert.equal(crashes.length, 0, "worker still alive after repeated command timeouts")
  } finally {
    await catalog.dispose()
  }
})

test("WorkerSession rejects pending commands when the worker exits before confirming", async () => {
  const catalog = startCatalog("exit-on-request")
  const crashes: Error[] = []
  catalog.onCrash(error => crashes.push(error))
  try {
    await catalog.getHandshake()
    const command = catalog.command("state.get")
    await assert.rejects(command, error => {
      assert.equal((error as { code?: string }).code, "WORKER_RESULT_UNKNOWN")
      return true
    })
    await waitFor(() => crashes.length > 0)
    assert.equal((crashes[0] as { code?: string }).code, "SESSION_RUNTIME_CRASHED")
  } finally {
    await catalog.dispose()
  }
})

test("WorkerSession rejects the handshake on a protocol version mismatch", async () => {
  const catalog = startCatalog("wrong-protocol")
  try {
    await assert.rejects(catalog.getHandshake(), error => {
      assert.equal((error as { code?: string }).code, "WORKER_PROTOCOL_MISMATCH")
      return true
    })
  } finally {
    await catalog.dispose()
  }
})

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
