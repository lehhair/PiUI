import assert from "node:assert/strict"
import { fork, type ChildProcess } from "node:child_process"
import { linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { SessionLeaseManager } from "./session-lease.ts"

describe("SessionLeaseManager", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it("allows one writer and releases the session for another supervisor", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-lease-test-"))
    roots.push(root)
    const first = new SessionLeaseManager(root)
    const second = new SessionLeaseManager(root)
    const sessionFile = path.join(root, "session.jsonl")
    try {
      const lease = await first.acquire(sessionFile)
      await assert.rejects(second.acquire(sessionFile), error => {
        assert.equal((error as { code?: string }).code, "SESSION_BUSY")
        return true
      })
      lease.release()
      const replacement = await second.acquire(sessionFile)
      replacement.release()
    } finally {
      first.dispose()
      second.dispose()
    }
  })

  it("allows exactly one independent process to acquire a session", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-lease-process-test-"))
    roots.push(root)
    const sessionFile = path.join(root, "cross-process.jsonl")
    const children = [startLeaseProcess(root, sessionFile), startLeaseProcess(root, sessionFile)]
    try {
      const results = await Promise.all(children.map(child => request(child, "acquire", ["acquired", "busy"])))
      assert.deepEqual(results.slice().sort(), ["acquired", "busy"])

      const winner = children[results.indexOf("acquired")]
      const loser = children[results.indexOf("busy")]
      await request(winner, "release", "released")
      assert.equal(await request(loser, "acquire", "acquired"), "acquired")
    } finally {
      for (const child of children) {
        if (child.connected) child.send("shutdown")
      }
      await Promise.all(children.map(waitForExit))
    }
  })

  it("treats hard links to one session file as the same lease", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-lease-link-test-"))
    roots.push(root)
    const sessionFile = path.join(root, "session.jsonl")
    const aliasFile = path.join(root, "session-alias.jsonl")
    writeFileSync(sessionFile, "")
    linkSync(sessionFile, aliasFile)
    const first = new SessionLeaseManager(root)
    const second = new SessionLeaseManager(root)
    try {
      const lease = await first.acquire(sessionFile)
      await assert.rejects(second.acquire(aliasFile), error => {
        assert.equal((error as { code?: string }).code, "SESSION_BUSY")
        return true
      })
      lease.release()
    } finally {
      first.dispose()
      second.dispose()
    }
  })

  it("keeps the same path lease after the session file is created", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-lease-create-test-"))
    roots.push(root)
    const sessionFile = path.join(root, "session.jsonl")
    const first = new SessionLeaseManager(root)
    const second = new SessionLeaseManager(root)
    try {
      const lease = await first.acquire(sessionFile)
      writeFileSync(sessionFile, "")
      await lease.refresh()
      await assert.rejects(second.acquire(sessionFile), error => {
        assert.equal((error as { code?: string }).code, "SESSION_BUSY")
        return true
      })
      lease.release()
    } finally {
      first.dispose()
      second.dispose()
    }
  })

  it("adds the physical file identity when a new session lease is refreshed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-lease-refresh-test-"))
    roots.push(root)
    const sessionFile = path.join(root, "session.jsonl")
    const aliasFile = path.join(root, "session-alias.jsonl")
    const first = new SessionLeaseManager(root)
    const second = new SessionLeaseManager(root)
    try {
      const lease = await first.acquire(sessionFile)
      writeFileSync(sessionFile, "")
      linkSync(sessionFile, aliasFile)
      await lease.refresh()
      await assert.rejects(second.acquire(aliasFile), error => {
        assert.equal((error as { code?: string }).code, "SESSION_BUSY")
        return true
      })
      lease.release()
    } finally {
      first.dispose()
      second.dispose()
    }
  })

  it("uses the Pi session id to reject a hard-link alias after delayed file creation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-lease-session-id-test-"))
    roots.push(root)
    const sessionFile = path.join(root, "session.jsonl")
    const aliasFile = path.join(root, "session-alias.jsonl")
    const first = new SessionLeaseManager(root)
    const second = new SessionLeaseManager(root)
    try {
      const lease = await first.acquire(sessionFile, "pi-session-id")
      writeFileSync(sessionFile, "")
      linkSync(sessionFile, aliasFile)
      const aliasLease = await second.acquire(aliasFile)
      await assert.rejects(aliasLease.refresh(aliasFile, "pi-session-id"), error => {
        assert.equal((error as { code?: string }).code, "SESSION_BUSY")
        return true
      })
      aliasLease.release()
      lease.release()
    } finally {
      first.dispose()
      second.dispose()
    }
  })
})

function startLeaseProcess(namespace: string, sessionFile: string): ChildProcess {
  return fork(new URL("./session-lease-fixture.mjs", import.meta.url), [namespace, sessionFile], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  })
}

function request(child: ChildProcess, command: string, expected: string | string[]): Promise<string> {
  const response = waitForMessage(child, expected)
  child.send(command)
  return response
}

function waitForMessage(child: ChildProcess, expected: string | string[]): Promise<string> {
  const accepted = new Set(Array.isArray(expected) ? expected : [expected])
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${[...accepted].join(" or ")}`)), 5_000)
    const onMessage = (message: unknown) => {
      if (typeof message === "string" && accepted.has(message)) finish(undefined, message)
      else if (typeof message === "string" && message.startsWith("error:")) finish(new Error(message))
    }
    const onExit = (code: number | null) => finish(new Error(`Lease fixture exited with code ${code}`))
    const finish = (error?: Error, message?: string) => {
      clearTimeout(timer)
      child.removeListener("message", onMessage)
      child.removeListener("exit", onExit)
      if (error) reject(error)
      else resolve(message!)
    }
    child.on("message", onMessage)
    child.once("exit", onExit)
  })
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill()
      resolve()
    }, 5_000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
