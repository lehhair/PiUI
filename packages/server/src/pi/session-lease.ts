import { realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { acquireDirectoryLock, type DirectoryLock } from "./directory-lock.ts"

export interface SessionLease {
  key: string
  refresh(sessionFile?: string, sessionId?: string): Promise<void>
  replace(sessionFile?: string, sessionId?: string): Promise<void>
  reserveReplacement?(targetSessionFile?: string): Promise<SessionReplacementReservation>
  release(): void
}

export interface SessionReplacementReservation {
  commit(sessionFile?: string, sessionId?: string): Promise<void>
  rollback(): void
}

export class SessionLeaseManager {
  private readonly held = new Set<SessionLease>()
  private disposed = false

  constructor(private readonly namespace = path.join(tmpdir(), "piui-session-leases")) {}

  async acquire(sessionFile: string, sessionId?: string): Promise<SessionLease> {
    if (this.disposed) throw new Error("Session lease manager is disposed")
    const allocation = await acquireDirectoryLock(this.namespace, "allocation")
    try {
      return await this.acquireWhileLocked(sessionFile, sessionId)
    } finally {
      allocation.release()
    }
  }

  private async acquireWhileLocked(sessionFile: string, sessionId?: string): Promise<SessionLease> {
    const initialKeys = leaseKeys(sessionFile, sessionId)
    const locks = new Map<string, DirectoryLock>()
    let currentSessionFile: string | undefined = sessionFile
    let currentSessionId: string | undefined = sessionId
    let released = false
    let refreshPromise: Promise<void> | undefined
    let replacementReservation: {
      allocation: DirectoryLock
      addedKeys: string[]
    } | undefined

    const acquireKeys = async (nextSessionFile = currentSessionFile, nextSessionId = currentSessionId): Promise<string[]> => {
      const added: string[] = []
      try {
        for (const key of leaseKeys(nextSessionFile, nextSessionId)) {
          if (locks.has(key)) continue
          if (released) throw new Error("Session lease is released")
          locks.set(key, await acquireDirectoryLock(this.namespace, key, { timeoutMs: 0 }))
          added.push(key)
        }
      } catch (error) {
        for (const key of added) {
          locks.get(key)?.release()
          locks.delete(key)
        }
        throw error
      }
      return added
    }

    await acquireKeys()
    const release = () => {
      if (released) return
      released = true
      replacementReservation?.allocation.release()
      replacementReservation = undefined
      this.held.delete(lease)
      for (const lock of locks.values()) lock.release()
      locks.clear()
    }
    const lease: SessionLease = {
      key: initialKeys[0]!,
      refresh: async (nextSessionFile, nextSessionId) => {
        if (released) throw new Error("Session lease is released")
        refreshPromise ??= (async () => {
          const allocation = await acquireDirectoryLock(this.namespace, "allocation")
          try {
            await acquireKeys(nextSessionFile, nextSessionId)
            currentSessionFile = nextSessionFile ?? currentSessionFile
            currentSessionId = nextSessionId ?? currentSessionId
          } finally {
            allocation.release()
          }
        })().finally(() => { refreshPromise = undefined })
        return refreshPromise
      },
      replace: async (nextSessionFile, nextSessionId) => {
        if (released) throw new Error("Session lease is released")
        const allocation = await acquireDirectoryLock(this.namespace, "allocation")
        try {
          await acquireKeys(nextSessionFile, nextSessionId)
          const target = new Set(leaseKeys(nextSessionFile, nextSessionId))
          for (const [key, lock] of locks) {
            if (target.has(key)) continue
            lock.release()
            locks.delete(key)
          }
          currentSessionFile = nextSessionFile ?? currentSessionFile
          currentSessionId = nextSessionId ?? currentSessionId
        } finally {
          allocation.release()
        }
      },
      reserveReplacement: async targetSessionFile => {
        if (released) throw new Error("Session lease is released")
        if (replacementReservation) throw new Error("Session replacement is already reserved")
        const allocation = await acquireDirectoryLock(this.namespace, "allocation")
        let addedKeys: string[] = []
        try {
          if (targetSessionFile) addedKeys = await acquireKeys(targetSessionFile, undefined)
        } catch (error) {
          allocation.release()
          throw error
        }
        replacementReservation = { allocation, addedKeys }
        let settled = false
        return {
          commit: async (nextSessionFile, nextSessionId) => {
            if (settled || replacementReservation?.allocation !== allocation) throw new Error("Replacement reservation is settled")
            await acquireKeys(nextSessionFile, nextSessionId)
            const target = new Set(leaseKeys(nextSessionFile, nextSessionId))
            for (const [key, lock] of locks) {
              if (target.has(key)) continue
              lock.release()
              locks.delete(key)
            }
            currentSessionFile = nextSessionFile ?? currentSessionFile
            currentSessionId = nextSessionId ?? currentSessionId
            settled = true
            replacementReservation = undefined
            allocation.release()
          },
          rollback: () => {
            if (settled || replacementReservation?.allocation !== allocation) return
            settled = true
            for (const key of addedKeys) {
              locks.get(key)?.release()
              locks.delete(key)
            }
            replacementReservation = undefined
            allocation.release()
          },
        }
      },
      release,
    }
    if (this.disposed) {
      release()
      throw new Error("Session lease manager is disposed")
    }
    this.held.add(lease)
    return lease
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const lease of [...this.held]) lease.release()
  }
}

function leaseKeys(sessionFile?: string, sessionId?: string): string[] {
  const keys = sessionFile ? canonicalFileKeys(sessionFile) : []
  if (sessionId) keys.push(`session:${sessionId}`)
  if (keys.length === 0) keys.push("session:unknown")
  return [...new Set(keys)].sort()
}

function canonicalFileKeys(sessionFile: string): string[] {
  const normalized = path.normalize(path.resolve(sessionFile))
  try {
    const physicalPath = realpathSync.native(normalized)
    const stats = statSync(normalized, { bigint: true })
    const keys = [`path:${normalizeCase(physicalPath)}`]
    if (stats.ino !== 0n) keys.push(`file:${stats.dev}:${stats.ino}`)
    return keys
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const parent = realpathSync.native(path.dirname(normalized))
  return ["path:" + normalizeCase(path.join(parent, path.basename(normalized)))]
}

function normalizeCase(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath
}
