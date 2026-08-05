import { useSyncExternalStore } from 'react'

const STORAGE_KEY_AUTO_START = 'piui-auto-start-service'
const STORAGE_KEY_ENV_VARS = 'piui-service-env-vars'

export interface EnvVar {
  key: string
  value: string
}

interface ServiceStoreSnapshot {
  autoStart: boolean
  envVars: EnvVar[]
  running: boolean
  startedByUs: boolean
  starting: boolean
}

class ServiceStore {
  private _autoStart: boolean
  private _envVars: EnvVar[]
  private _running = false
  private _startedByUs = false
  private _starting = false
  private _listeners = new Set<() => void>()
  private _snapshot: ServiceStoreSnapshot

  constructor() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_AUTO_START)
      this._autoStart = stored === null ? true : stored === 'true'
    } catch {
      this._autoStart = true
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ENV_VARS)
      const parsed = raw ? JSON.parse(raw) : []
      this._envVars = Array.isArray(parsed)
        ? parsed.filter(item => item && typeof item.key === 'string' && typeof item.value === 'string')
        : []
    } catch {
      this._envVars = []
    }
    this._snapshot = this.buildSnapshot()
  }

  get autoStart() {
    return this._autoStart
  }

  get envVars() {
    return this._envVars
  }

  get envVarsRecord(): Record<string, string> {
    return Object.fromEntries(
      this._envVars
        .map(item => [item.key.trim(), item.value] as const)
        .filter(([key]) => key.length > 0),
    )
  }

  setAutoStart(value: boolean) {
    this._autoStart = value
    try {
      localStorage.setItem(STORAGE_KEY_AUTO_START, String(value))
    } catch {
      // Storage can be unavailable in restricted webviews.
    }
    this.notify()
  }

  setEnvVars(value: EnvVar[]) {
    this._envVars = value
    try {
      localStorage.setItem(STORAGE_KEY_ENV_VARS, JSON.stringify(value))
    } catch {
      // Storage can be unavailable in restricted webviews.
    }
    this.notify()
  }

  setRunning(value: boolean) {
    this._running = value
    this.notify()
  }

  setStartedByUs(value: boolean) {
    this._startedByUs = value
    this.notify()
  }

  setStarting(value: boolean) {
    this._starting = value
    this.notify()
  }

  subscribe = (listener: () => void) => {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  getSnapshot = () => this._snapshot

  private buildSnapshot(): ServiceStoreSnapshot {
    return {
      autoStart: this._autoStart,
      envVars: this._envVars,
      running: this._running,
      startedByUs: this._startedByUs,
      starting: this._starting,
    }
  }

  private notify() {
    this._snapshot = this.buildSnapshot()
    this._listeners.forEach(listener => listener())
  }
}

export const serviceStore = new ServiceStore()

export function useServiceStore() {
  return useSyncExternalStore(serviceStore.subscribe, serviceStore.getSnapshot)
}
