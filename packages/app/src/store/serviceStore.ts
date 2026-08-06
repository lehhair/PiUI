import { useSyncExternalStore } from 'react'

const STORAGE_KEY_AUTO_START = 'piui-auto-start-service'
const STORAGE_KEY_ENV_VARS = 'piui-service-env-vars'

export interface EnvVar {
  key: string
  value: string
}

export interface ServiceSettingsBackup {
  autoStart: boolean
  envVars: EnvVar[]
}

export const SERVICE_ENV_EXAMPLES: EnvVar[] = [
  { key: 'PIUI_SDK_PATH', value: '/path/to/pi-coding-agent' },
  { key: 'PI_CODING_AGENT_DIR', value: '~/.pi/agent' },
  { key: 'PI_CODING_AGENT_SESSION_DIR', value: '~/.pi/agent/sessions' },
  { key: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' },
  { key: 'PIUI_HOST', value: '0.0.0.0' },
  { key: 'PIUI_PORT', value: '8787' },
]

interface ServiceStoreSnapshot {
  autoStart: boolean
  useSystemPiSdk: boolean
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

  get useSystemPiSdk() {
    return this._envVars.some(
      item => item.key.trim().toUpperCase() === 'PIUI_USE_SYSTEM_PI' && item.value.trim() === '1',
    )
  }

  get envVarsRecord(): Record<string, string> {
    return Object.fromEntries(
      this._envVars.map(item => [item.key.trim(), item.value] as const).filter(([key]) => key.length > 0),
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

  setUseSystemPiSdk(value: boolean) {
    const envVars = this._envVars.filter(item => item.key.trim().toUpperCase() !== 'PIUI_USE_SYSTEM_PI')
    if (value) envVars.push({ key: 'PIUI_USE_SYSTEM_PI', value: '1' })
    this.setEnvVars(envVars)
  }

  upsertEnvVar(key: string, value: string) {
    const normalized = key.trim().toUpperCase()
    const index = this._envVars.findIndex(item => item.key.trim().toUpperCase() === normalized)
    const envVars = [...this._envVars]
    if (index >= 0) envVars[index] = { key, value }
    else envVars.push({ key, value })
    this.setEnvVars(envVars)
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
      useSystemPiSdk: this.useSystemPiSdk,
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

export function exportServiceSettingsBackup(): ServiceSettingsBackup {
  return {
    autoStart: serviceStore.autoStart,
    envVars: serviceStore.envVars.map(item => ({ ...item })),
  }
}

export function importServiceSettingsBackup(raw: unknown): void {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const envVars = Array.isArray(parsed?.envVars)
    ? parsed.envVars
        .filter(
          (item): item is EnvVar =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).key === 'string' &&
            typeof (item as Record<string, unknown>).value === 'string',
        )
        .map(item => ({ key: item.key, value: item.value }))
    : []

  serviceStore.setAutoStart(parsed?.autoStart !== false)
  serviceStore.setEnvVars(envVars)
}

export function useServiceStore() {
  return useSyncExternalStore(serviceStore.subscribe, serviceStore.getSnapshot)
}
