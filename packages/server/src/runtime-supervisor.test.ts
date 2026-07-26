import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { RuntimeSupervisor } from "./runtime-supervisor.ts"
import { SessionLeaseManager } from "./session-lease.ts"

const fixture = new URL("./pi-worker-fixture.mjs", import.meta.url)
const crashingCatalogFixture = new URL("./pi-worker-catalog-crash-fixture.mjs", import.meta.url)

describe("RuntimeSupervisor", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it("holds the single-writer lease for the worker lifecycle", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-supervisor-test-"))
    roots.push(root)
    const lockRoot = path.join(root, "locks")
    const sessionFile = path.join(root, "session.jsonl")
    const first = new RuntimeSupervisor({
      workerEntry: fixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: new SessionLeaseManager(lockRoot),
    })
    const second = new RuntimeSupervisor({
      workerEntry: fixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: new SessionLeaseManager(lockRoot),
    })
    try {
      const runtime = await first.open(root, sessionFile)
      await assert.rejects(second.open(root, sessionFile), error => {
        assert.equal((error as { code?: string }).code, "SESSION_BUSY")
        return true
      })
      await runtime.dispose()
      const replacement = await second.open(root, sessionFile)
      await replacement.dispose()
    } finally {
      await first.dispose()
      await second.dispose()
    }
  })

  it("releases the lease after a worker crash without replaying the prompt", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-supervisor-crash-"))
    roots.push(root)
    const lockRoot = path.join(root, "locks")
    const sessionFile = path.join(root, "session.jsonl")
    const first = new RuntimeSupervisor({
      workerEntry: fixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: new SessionLeaseManager(lockRoot),
    })
    const second = new RuntimeSupervisor({
      workerEntry: fixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: new SessionLeaseManager(lockRoot),
    })
    try {
      const runtime = await first.open(root, sessionFile)
      const closed = new Promise<void>(resolve => runtime.onClose(resolve))
      await assert.rejects(runtime.prompt("crash"), /exited unexpectedly/)
      await closed
      const replacement = await second.open(root, sessionFile)
      assert.equal(replacement.getProjection().timeline.length, 0)
      await replacement.dispose()
    } finally {
      await first.dispose()
      await second.dispose()
    }
  })

  it("moves the lease from the source session to a fork target", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-supervisor-fork-"))
    roots.push(root)
    const lockRoot = path.join(root, "locks")
    const sourceFile = path.join(root, "source.jsonl")
    const first = new RuntimeSupervisor({ workerEntry: fixture, leases: new SessionLeaseManager(lockRoot) })
    const second = new RuntimeSupervisor({ workerEntry: fixture, leases: new SessionLeaseManager(lockRoot) })
    try {
      const forkedRuntime = await first.open(root, sourceFile)
      const replacement = await forkedRuntime.fork("fixture-entry", "at")
      assert.notEqual(replacement.targetSessionId, replacement.sourceSessionId)
      const targetFile = replacement.targetSessionFile
      assert.ok(targetFile)

      const sourceRuntime = await second.open(root, sourceFile)
      await assert.rejects(second.open(root, targetFile), error => {
        assert.equal((error as { code?: string }).code, "SESSION_BUSY")
        return true
      })
      await sourceRuntime.dispose()
      await forkedRuntime.dispose()
    } finally {
      await first.dispose()
      await second.dispose()
    }
  })

  it("disposes a replaced worker when the target lease cannot be acquired", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-supervisor-fork-fail-"))
    roots.push(root)
    let released = false
    const supervisor = new RuntimeSupervisor({
      workerEntry: fixture,
      leases: {
        acquire: async sessionFile => ({
          key: sessionFile,
          refresh: async () => undefined,
          replace: async () => {
            throw Object.assign(new Error("target is busy"), { code: "SESSION_BUSY" })
          },
          release: () => { released = true },
        }),
        dispose: () => undefined,
      },
    })
    try {
      const runtime = await supervisor.open(root, path.join(root, "source.jsonl"))
      const closed = new Promise<void>(resolve => runtime.onClose(resolve))
      await assert.rejects(runtime.fork("fixture-entry", "at"), error => {
        assert.equal((error as { code?: string }).code, "SESSION_REPLACEMENT_COMMIT_FAILED")
        return true
      })
      await closed
      assert.equal(released, true)
    } finally {
      await supervisor.dispose()
    }
  })

  it("keeps the lease until an unhealthy worker process really closes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-supervisor-heartbeat-"))
    roots.push(root)
    const lockRoot = path.join(root, "locks")
    const sessionFile = path.join(root, "session.jsonl")
    const first = new RuntimeSupervisor({
      workerEntry: fixture,
      worker: { heartbeatTimeoutMs: 60 },
      leases: new SessionLeaseManager(lockRoot),
    })
    const second = new RuntimeSupervisor({
      workerEntry: fixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: new SessionLeaseManager(lockRoot),
    })
    try {
      const runtime = await first.open(root, sessionFile)
      let duringCrash: Promise<unknown> | undefined
      runtime.onCrash?.(() => {
        duringCrash = second.open(root, sessionFile)
        void duringCrash.catch(() => undefined)
      })
      const closed = new Promise<void>(resolve => runtime.onClose(resolve))
      await assert.rejects(runtime.prompt("hang"), /heartbeat timeout/i)
      assert.ok(duringCrash)
      await assert.rejects(duringCrash, error => {
        assert.equal((error as { code?: string }).code, "SESSION_BUSY")
        return true
      })
      await closed
      const replacement = await second.open(root, sessionFile)
      await replacement.dispose()
    } finally {
      await first.dispose()
      await second.dispose()
    }
  })

  it("cancels a worker that is still opening during supervisor disposal", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-supervisor-opening-"))
    roots.push(root)
    const lockRoot = path.join(root, "locks")
    const sessionFile = path.join(root, "session.jsonl")
    const first = new RuntimeSupervisor({
      workerEntry: fixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: new SessionLeaseManager(lockRoot),
    })
    const opening = first.open(`${root}/hang-open`, sessionFile)
    void opening.catch(() => undefined)
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    await first.dispose()
    await assert.rejects(opening)

    const second = new RuntimeSupervisor({
      workerEntry: fixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: new SessionLeaseManager(lockRoot),
    })
    try {
      const replacement = await second.open(root, sessionFile)
      await replacement.dispose()
    } finally {
      await second.dispose()
    }
  })

  it("keeps warm workers ready so a burst of openings does not pay boot cost", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-supervisor-standby-"))
    roots.push(root)
    // The fixture reports one fixed session id, so a real lease would collide
    // on the second open. Leases are covered elsewhere; this test is about the
    // warm pool.
    const supervisor = new RuntimeSupervisor({
      workerEntry: fixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: {
        acquire: async sessionFile => ({
          key: sessionFile,
          refresh: async () => undefined,
          replace: async () => undefined,
          release: () => undefined,
        }),
        dispose: () => undefined,
      },
      standbySize: 3,
    })
    const pool = () => (supervisor as unknown as { standbyPool: unknown[] }).standbyPool
    try {
      assert.equal(pool().length, 3, "the pool should be warm before any open")

      // Each open consumes a warm worker, and the pool refills immediately so
      // the next open in the burst still hits a warm one.
      const runtimes = []
      for (let i = 0; i < 3; i += 1) {
        runtimes.push(await supervisor.open(root, path.join(root, `session-${i}.jsonl`)))
        assert.equal(pool().length, 3, `pool should stay warm after open ${i}`)
      }
      for (const runtime of runtimes) await runtime.dispose()
    } finally {
      await supervisor.dispose()
    }
    assert.equal(pool().length, 0, "disposal must not leave warm workers behind")
  })

  it("does not create another standby while a lease acquisition is being disposed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-supervisor-lease-wait-"))
    roots.push(root)
    let continueAcquire!: () => void
    let acquireStarted!: () => void
    let leaseReleased = false
    const acquireGate = new Promise<void>(resolve => { continueAcquire = resolve })
    const started = new Promise<void>(resolve => { acquireStarted = resolve })
    const supervisor = new RuntimeSupervisor({
      workerEntry: fixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: {
        acquire: async sessionFile => {
          acquireStarted()
          await acquireGate
          return {
            key: sessionFile,
            refresh: async () => undefined,
            replace: async () => undefined,
            release: () => { leaseReleased = true },
          }
        },
        dispose: () => undefined,
      },
    })
    const opening = supervisor.open(root, path.join(root, "session.jsonl"))
    void opening.catch(() => undefined)
    await started
    let disposed = false
    const disposing = supervisor.dispose().then(() => { disposed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(disposed, false)
    continueAcquire()

    await disposing
    await assert.rejects(opening, /disposed/i)
    assert.equal(leaseReleased, true)
  })

  it("waits for post-open lease refresh before disposal completes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-supervisor-refresh-wait-"))
    roots.push(root)
    let continueRefresh!: () => void
    let refreshStarted!: () => void
    const refreshGate = new Promise<void>(resolve => { continueRefresh = resolve })
    const started = new Promise<void>(resolve => { refreshStarted = resolve })
    const supervisor = new RuntimeSupervisor({
      workerEntry: fixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: {
        acquire: async sessionFile => ({
          key: sessionFile,
          refresh: async () => {
            refreshStarted()
            await refreshGate
          },
          replace: async () => undefined,
          release: () => undefined,
        }),
        dispose: () => undefined,
      },
    })
    const opening = supervisor.open(root, path.join(root, "session.jsonl"))
    void opening.catch(() => undefined)
    await started
    let disposed = false
    const disposing = supervisor.dispose().then(() => { disposed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(disposed, false)
    continueRefresh()

    await disposing
    await assert.rejects(opening, /disposed/i)
  })

  it("replaces a crashed catalog worker for later discovery", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-supervisor-test-"))
    roots.push(root)
    const supervisor = new RuntimeSupervisor({
      workerEntry: crashingCatalogFixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: new SessionLeaseManager(path.join(root, "locks")),
    })
    try {
      assert.equal((await supervisor.listAll())[0]?.id, "catalog-fixture")
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal((await supervisor.listAll())[0]?.id, "catalog-fixture")
    } finally {
      await supervisor.dispose()
    }
  })

  it("does not replay catalog mutations after a worker crash", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-supervisor-test-"))
    roots.push(root)
    const supervisor = new RuntimeSupervisor({
      workerEntry: crashingCatalogFixture,
      worker: { heartbeatTimeoutMs: 500 },
      leases: new SessionLeaseManager(path.join(root, "locks")),
    })
    try {
      await assert.rejects(supervisor.patchSettings("/fixture", {}), (error: { code?: string }) => {
        assert.equal(error.code, "WORKER_RESULT_UNKNOWN")
        return true
      })
      // Read-only discovery still recovers on a fresh worker afterwards.
      assert.equal((await supervisor.listAll())[0]?.id, "catalog-fixture")
    } finally {
      await supervisor.dispose()
    }
  })
})
