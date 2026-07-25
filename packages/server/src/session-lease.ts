import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

const PORT_BASE = 49_152
const PORT_COUNT = 65_535 - PORT_BASE + 1

export interface SessionLease {
  key: string
  refresh(sessionFile?: string, sessionId?: string): Promise<void>
  replace(sessionFile?: string, sessionId?: string): Promise<void>
  release(): void
}

export class SessionLeaseManager {
  private readonly held = new Set<SessionLease>()
  private disposed = false

  constructor(private readonly namespace = path.join(tmpdir(), "piui-session-leases")) {}

  async acquire(sessionFile: string, sessionId?: string): Promise<SessionLease> {
    if (this.disposed) throw new Error("Session lease manager is disposed")
    const keys = leaseKeys(sessionFile, sessionId)
    const servers = new Map<number, Server>()
    let currentSessionFile: string | undefined = sessionFile
    let currentSessionId: string | undefined = sessionId
    let released = false
    let refreshPromise: Promise<void> | undefined

    const acquireKeys = async (nextSessionFile = currentSessionFile, nextSessionId = currentSessionId): Promise<void> => {
      const added: number[] = []
      try {
        for (const port of leasePorts(this.namespace, leaseKeys(nextSessionFile, nextSessionId))) {
          if (servers.has(port)) continue
          if (released) throw new Error("Session lease is released")
          const server = createServer(socket => socket.destroy())
          server.unref()
          if (await tryListen(server, port) === "occupied") throw sessionBusyError()
          if (released) {
            server.close()
            throw new Error("Session lease is released")
          }
          servers.set(port, server)
          added.push(port)
        }
      } catch (error) {
        for (const port of added) {
          servers.get(port)?.close()
          servers.delete(port)
        }
        throw error
      }
    }
    await acquireKeys()
    const lease: SessionLease = {
      key: keys[0],
      refresh: (nextSessionFile, nextSessionId) => {
        if (released) return Promise.reject(new Error("Session lease is released"))
        refreshPromise ??= acquireKeys(nextSessionFile, nextSessionId).then(() => {
          currentSessionFile = nextSessionFile ?? currentSessionFile
          currentSessionId = nextSessionId ?? currentSessionId
        }).finally(() => { refreshPromise = undefined })
        return refreshPromise
      },
      replace: async (nextSessionFile, nextSessionId) => {
        if (released) throw new Error("Session lease is released")
        await acquireKeys(nextSessionFile, nextSessionId)
        const targetPorts = new Set(leasePorts(this.namespace, leaseKeys(nextSessionFile, nextSessionId)))
        for (const [port, server] of servers) {
          if (targetPorts.has(port)) continue
          server.close()
          servers.delete(port)
        }
        currentSessionFile = nextSessionFile
        currentSessionId = nextSessionId
      },
      release: () => {
        if (released) return
        released = true
        this.held.delete(lease)
        for (const server of servers.values()) server.close()
        servers.clear()
      },
    }
    if (this.disposed) {
      lease.release()
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

function leasePort(leaseId: string): number {
  const digest = createHash("sha512").update(leaseId).digest()
  return PORT_BASE + (digest.readUInt16BE(0) % PORT_COUNT)
}

function leasePorts(namespace: string, keys: string[]): number[] {
  return [...new Set(keys.map(key => {
    const leaseId = createHash("sha256").update(`${namespace}\0${key}`).digest("hex")
    return leasePort(leaseId)
  }))].sort((a, b) => a - b)
}

function leaseKeys(sessionFile?: string, sessionId?: string): string[] {
  const keys = sessionFile ? canonicalFileKeys(sessionFile) : []
  if (sessionId) keys.push(`session:${sessionId}`)
  if (keys.length === 0) keys.push("session:unknown")
  return keys
}

function tryListen(server: Server, port: number): Promise<"listening" | "occupied"> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening)
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve("occupied")
      else reject(error)
    }
    const onListening = () => {
      server.removeListener("error", onError)
      resolve("listening")
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen({ port, host: "127.0.0.1", exclusive: true })
  })
}

function canonicalFileKeys(sessionFile: string): string[] {
  const normalized = path.normalize(path.resolve(sessionFile))
  let physicalPath: string
  try {
    physicalPath = realpathSync.native(normalized)
    const stats = statSync(normalized, { bigint: true })
    const keys = [`path:${normalizeCase(physicalPath)}`]
    if (stats.ino !== 0n) keys.push(`file:${stats.dev}:${stats.ino}`)
    return keys
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const parent = realpathSync.native(path.dirname(normalized))
  physicalPath = path.join(parent, path.basename(normalized))
  return [`path:${normalizeCase(physicalPath)}`]
}

function normalizeCase(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath
}

function sessionBusyError(): Error {
  return Object.assign(new Error("Pi session is already attached by another runtime"), {
    code: "SESSION_BUSY",
    retryable: true,
  })
}
