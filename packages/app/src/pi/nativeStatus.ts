import { useSyncExternalStore } from 'react'
import type { HealthResponse, PiRegistrySnapshot } from '@piui/protocol'
import { fetchHostHealth, fetchPiRegistry } from './transport/index.js'
import { setPiRegistryCapabilities } from './capabilities'

const CORE_PI_COMMANDS = [
  'session.open',
  'session.listAll',
  'state.get',
  'branch.get',
  'prompt',
  'abort',
  'registry.get',
]

export type PiNativeStatus = {
  status: 'booting' | 'online' | 'degraded' | 'offline' | 'unauthorized'
  health?: HealthResponse
  registry?: PiRegistrySnapshot
  missingCoreCommands: string[]
  error?: string
  checkedAt?: number
}

let current: PiNativeStatus = {
  status: 'booting',
  missingCoreCommands: CORE_PI_COMMANDS,
}
const listeners = new Set<() => void>()

export function getPiNativeStatus(): PiNativeStatus {
  return current
}

export function usePiNativeStatus(): PiNativeStatus {
  return useSyncExternalStore(subscribe, getPiNativeStatus, getPiNativeStatus)
}

export async function refreshPiNativeStatus(signal?: AbortSignal): Promise<PiNativeStatus> {
  setStatus({ ...current, status: 'booting', error: undefined })
  try {
    const [health, registry] = await Promise.all([
      fetchHostHealth(signal),
      fetchPiRegistry(signal),
    ])
    const missingCoreCommands = missingCore(registry)
    const next: PiNativeStatus = {
      status: missingCoreCommands.length > 0 ? 'degraded' : 'online',
      health,
      registry,
      missingCoreCommands,
      checkedAt: Date.now(),
    }
    setPiRegistryCapabilities(registry)
    setStatus(next)
    return next
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setPiRegistryCapabilities(undefined)
    const next: PiNativeStatus = {
      status: /\b(401|403)\b/.test(message) ? 'unauthorized' : 'offline',
      missingCoreCommands: CORE_PI_COMMANDS,
      error: message,
      checkedAt: Date.now(),
    }
    setStatus(next)
    return next
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setStatus(next: PiNativeStatus): void {
  current = next
  for (const listener of listeners) listener()
}

function missingCore(registry: PiRegistrySnapshot): string[] {
  const names = new Set([
    ...registry.globalCommands.map(command => command.name),
    ...registry.sessionCommands.map(command => command.name),
  ])
  return CORE_PI_COMMANDS.filter(name => !names.has(name))
}
