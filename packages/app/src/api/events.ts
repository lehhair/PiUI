import type { EventCallbacks } from '../types/api/event'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface ConnectionInfo {
  state: ConnectionState
  error?: string
  lastEventTime: number
  reconnectAttempt: number
  reconnectedAt?: number
  reconnectReason?: 'network' | 'server-switch'
}

let connectionInfo: ConnectionInfo = {
  state: 'disconnected',
  lastEventTime: 0,
  reconnectAttempt: 0,
}

const listeners = new Set<(info: ConnectionInfo) => void>()

export function getConnectionInfo(): ConnectionInfo {
  return connectionInfo
}

export function subscribeToConnectionState(listener: (info: ConnectionInfo) => void): () => void {
  listeners.add(listener)
  listener(connectionInfo)
  return () => listeners.delete(listener)
}

export function reportPiConnectionState(
  state: ConnectionState,
  details: Partial<Omit<ConnectionInfo, 'state'>> = {},
) {
  connectionInfo = { ...connectionInfo, ...details, state }
  for (const listener of listeners) listener(connectionInfo)
}

/** PiUI has no OpenCode SSE transport. */
export function reconnectSSE() {}

export function disconnectSSE(error?: string) {
  reportPiConnectionState('disconnected', { error })
}

export function subscribeToEvents(_callbacks: EventCallbacks): () => void {
  return () => {}
}
