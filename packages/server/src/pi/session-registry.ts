import { resolve } from "node:path"
import type { WorkerSession } from "./worker-client.ts"

export interface AttachedSession {
  sessionId: string
  cwd: string
  sessionFile?: string
  worker: WorkerSession
}

function sessionFileKey(sessionFile: string): string {
  const normalized = resolve(sessionFile).replace(/\\/g, "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export class SessionRuntimeRegistry {
  private readonly sessions = new Map<string, AttachedSession>()
  private readonly openFlights = new Map<string, Promise<unknown>>()
  private readonly attachFlights = new Map<string, Promise<AttachedSession>>()

  get(sessionId: string): AttachedSession | undefined {
    return this.sessions.get(sessionId)
  }

  values(): IterableIterator<AttachedSession> {
    return this.sessions.values()
  }

  keys(): IterableIterator<string> {
    return this.sessions.keys()
  }

  set(session: AttachedSession): void {
    this.sessions.set(session.sessionId, session)
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  findBySessionFile(sessionFile: string): AttachedSession | undefined {
    const key = sessionFileKey(sessionFile)
    return [...this.sessions.values()].find(session => session.sessionFile && sessionFileKey(session.sessionFile) === key)
  }

  async openFlight<T>(sessionFile: string, operation: () => Promise<T>): Promise<T> {
    const key = sessionFileKey(sessionFile)
    const existing = this.openFlights.get(key)
    if (existing) return existing as Promise<T>
    const flight = operation()
    this.openFlights.set(key, flight)
    try {
      return await flight
    } finally {
      if (this.openFlights.get(key) === flight) this.openFlights.delete(key)
    }
  }

  async attachFlight(sessionId: string, operation: () => Promise<AttachedSession>): Promise<AttachedSession> {
    const existing = this.attachFlights.get(sessionId)
    if (existing) return existing
    const flight = operation()
    this.attachFlights.set(sessionId, flight)
    try {
      return await flight
    } finally {
      if (this.attachFlights.get(sessionId) === flight) this.attachFlights.delete(sessionId)
    }
  }
}
