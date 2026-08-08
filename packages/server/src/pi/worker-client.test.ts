import assert from "node:assert/strict"
import test from "node:test"
import { WorkerSession, type WorkerCatalog } from "./worker-client.ts"

function startCatalog(mode: string): WorkerCatalog {
  return WorkerSession.createCatalog(new URL("./worker-client-fixture.mjs", import.meta.url), {
    env: { PIUI_FIXTURE_MODE: mode },
    execArgv: ["--import", "tsx"],
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
