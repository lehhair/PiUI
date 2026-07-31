import type { EventCallbacks } from '../types/api/event'
import { serverStore, type ServerHealth } from '../store/serverStore'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface ConnectionInfo {
  state: ConnectionState
  error?: string
  lastEventTime: number
  reconnectAttempt: number
  reconnectedAt?: number
  reconnectReason?: 'network' | 'server-switch'
}

const HEALTH_POLL_INTERVAL_MS = 30_000

let connectionInfo: ConnectionInfo = {
  state: 'disconnected',
  lastEventTime: 0,
  reconnectAttempt: 0,
}

const listeners = new Set<(info: ConnectionInfo) => void>()

export function getConnectionInfo(): ConnectionInfo {
  return connectionInfo
}

function mapHealthToState(health: ServerHealth | null): ConnectionState {
  switch (health?.status) {
    case 'online':
      return 'connected'
    case 'checking':
      return 'connecting'
    case 'error':
    case 'unauthorized':
      return 'error'
    default:
      return 'disconnected'
  }
}

let tracking = false
let serverSwitchPending = false

function syncFromStore(): void {
  const health = serverStore.getHealth(serverStore.getActiveServerId())
  const previousState = connectionInfo.state
  const nextState = mapHealthToState(health)
  connectionInfo = {
    ...connectionInfo,
    state: nextState,
    error: health?.error,
    lastEventTime: health?.lastCheck ?? connectionInfo.lastEventTime,
  }
  if (previousState !== 'connected' && nextState === 'connected') {
    connectionInfo.reconnectedAt = Date.now()
    connectionInfo.reconnectReason = serverSwitchPending ? 'server-switch' : 'network'
    serverSwitchPending = false
  }
  for (const listener of listeners) listener(connectionInfo)
}

function checkActiveServerHealth(): void {
  void serverStore.checkHealth(serverStore.getActiveServerId())
}

function ensureTracking(): void {
  if (tracking || typeof window === 'undefined') return
  tracking = true
  serverStore.subscribe(syncFromStore)
  serverStore.onServerChange(() => {
    serverSwitchPending = true
    syncFromStore()
    checkActiveServerHealth()
  })
  window.setInterval(checkActiveServerHealth, HEALTH_POLL_INTERVAL_MS)
  syncFromStore()
  checkActiveServerHealth()
}

export function subscribeToConnectionState(listener: (info: ConnectionInfo) => void): () => void {
  listeners.add(listener)
  ensureTracking()
  listener(connectionInfo)
  return () => listeners.delete(listener)
}

/**
 * Reconnect notifications are derived from health-state transitions; the
 * worktree callbacks never fire (pi has no worktrees).
 */
export function subscribeToEvents(callbacks: EventCallbacks): () => void {
  if (!callbacks.onReconnected) return () => {}
  let previousState = connectionInfo.state
  return subscribeToConnectionState(info => {
    const wasConnected = previousState === 'connected'
    previousState = info.state
    if (!wasConnected && info.state === 'connected') {
      callbacks.onReconnected?.(info.reconnectReason ?? 'network')
    }
  })
}
