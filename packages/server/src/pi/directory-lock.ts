import { createHash, randomUUID } from "node:crypto"
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { readFileSync, rmSync } from "node:fs"
import path from "node:path"

const DEFAULT_STALE_MS = 60_000
const DEFAULT_TIMEOUT_MS = 15_000

export interface DirectoryLock {
  release(): void
}

export async function acquireDirectoryLock(
  root: string,
  key: string,
  options: { staleMs?: number; timeoutMs?: number; busyCode?: "SESSION_BUSY" | "WORKSPACE_BUSY" } = {},
): Promise<DirectoryLock> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const lockRoot = path.resolve(root)
  const lockPath = path.join(lockRoot, `${createHash("sha256").update(key).digest("hex")}.lock`)
  const deadline = Date.now() + timeoutMs

  await mkdir(lockRoot, { recursive: true })
  while (true) {
    const token = randomUUID()
    let created = false
    try {
      await mkdir(lockPath)
      created = true
      await writeFile(
        path.join(lockPath, "meta.json"),
        JSON.stringify({ token, key, pid: process.pid, createdAt: new Date().toISOString() }),
        { flag: "wx", mode: 0o600 },
      )
      const heartbeatPath = path.join(lockPath, "heartbeat")
      await writeFile(heartbeatPath, "", { flag: "wx", mode: 0o600 })
      const timer = setInterval(() => {
        const now = new Date()
        void utimes(heartbeatPath, now, now).catch(() => undefined)
      }, Math.max(100, Math.floor(staleMs / 3)))
      timer.unref()
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          clearInterval(timer)
          try {
            const meta = JSON.parse(readFileSync(path.join(lockPath, "meta.json"), "utf8")) as { token?: unknown }
            if (meta.token !== token) return
            rmSync(lockPath, { recursive: true, force: true })
          } catch {
            // A stale-lock breaker or another cleanup may have removed it.
          }
        },
      }
    } catch (error) {
      if (created) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      if (await removeStaleLock(lockPath, staleMs)) continue
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`lock is busy: ${key}`), {
          code: options.busyCode ?? "SESSION_BUSY",
          retryable: true,
        })
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}

async function removeStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const heartbeatPath = path.join(lockPath, "heartbeat")
  const marker = `${lockPath}.breaker`
  let heartbeat: Awaited<ReturnType<typeof stat>> | undefined
  try {
    heartbeat = await stat(heartbeatPath)
  } catch {
    try {
      heartbeat = await stat(lockPath)
    } catch {
      return false
    }
  }
  if (Date.now() - heartbeat.mtimeMs <= staleMs) return false
  try {
    await mkdir(marker)
  } catch {
    return false
  }
  try {
    let latest: Awaited<ReturnType<typeof stat>>
    try {
      latest = await stat(heartbeatPath)
    } catch {
      latest = await stat(lockPath)
    }
    if (Date.now() - latest.mtimeMs > staleMs) {
      await rm(lockPath, { recursive: true, force: true })
      return true
    }
    return false
  } finally {
    await rm(marker, { recursive: true, force: true }).catch(() => undefined)
  }
}
