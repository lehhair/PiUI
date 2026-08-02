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
  private readonly openFlights = new Map<string, {
    promise: Promise<unknown>
    controller: AbortController
    waiters: number
  }>()
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

  async openFlight<T>(sessionFile: string, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const key = sessionFileKey(sessionFile)
    let flight = this.openFlights.get(key)
    if (!flight) {
      const controller = new AbortController()
      const promise = Promise.resolve().then(() => operation(controller.signal))
      flight = { promise, controller, waiters: 0 }
      this.openFlights.set(key, flight)
      const current = flight
      void promise.then(
        () => { if (this.openFlights.get(key) === current) this.openFlights.delete(key) },
        () => { if (this.openFlights.get(key) === current) this.openFlights.delete(key) },
      )
    }
    flight.waiters += 1
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const cleanup = () => signal?.removeEventListener("abort", abort)
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        flight!.waiters -= 1
        cleanup()
        callback()
      }
      const abort = () => finish(() => {
        if (flight!.waiters === 0) {
          flight!.controller.abort()
          if (this.openFlights.get(key) === flight) this.openFlights.delete(key)
        }
        reject(Object.assign(new Error("request aborted"), { code: "REQUEST_ABORTED" }))
      })
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener("abort", abort, { once: true })
      flight!.promise.then(
        value => finish(() => resolve(value as T)),
        error => finish(() => reject(error)),
      )
    })
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
