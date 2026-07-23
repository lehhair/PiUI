import { getAuthHeader } from './http'
import { getPtyConnectUrl } from './pty'

/** Unified bridge event from Rust */
interface BridgeEvent {
  event: 'connected' | 'data' | 'disconnected' | 'error'
  data?: {
    data?: string
    code?: number
    reason?: string
    message?: string
  }
}

interface ConnectTauriPtyParams {
  ptyId: string
  directory?: string
  cursor?: number
  onConnected: () => void
  onMessage: (chunk: string) => void
  onDisconnected: (info: { code?: number; reason?: string }) => void
  onError: (message: string) => void
}

export interface TauriPtyConnection {
  send: (data: string) => void
  close: () => void
}

export async function connectTauriPty({
  ptyId,
  directory,
  cursor,
  onConnected,
  onMessage,
  onDisconnected,
  onError,
}: ConnectTauriPtyParams): Promise<TauriPtyConnection> {
  const { invoke, Channel } = await import('@tauri-apps/api/core')
  const url = getPtyConnectUrl(ptyId, directory, { includeAuthInUrl: false, cursor })
  const authHeader = getAuthHeader()['Authorization'] || null
  const onEvent = new Channel<BridgeEvent>()
  let closed = false

  onEvent.onmessage = msg => {
    if (closed) return

    switch (msg.event) {
      case 'connected':
        onConnected()
        break
      case 'data':
        if (msg.data?.data) {
          onMessage(msg.data.data)
        }
        break
      case 'disconnected':
        closed = true
        onDisconnected({ code: msg.data?.code, reason: msg.data?.reason })
        break
      case 'error':
        onError(msg.data?.message || 'Unknown bridge error')
        break
    }
  }

  void invoke('bridge_connect', {
    args: { bridgeId: ptyId, url, authHeader },
    onEvent,
  }).catch((error: unknown) => {
    if (closed) return
    closed = true
    const message = error instanceof Error ? error.message : String(error)
    onDisconnected({ reason: message })
  })

  return {
    send(data: string) {
      if (closed) return
      void invoke('bridge_send', { args: { bridgeId: ptyId, data } }).catch((error: unknown) => {
        if (closed) return
        const message = error instanceof Error ? error.message : String(error)
        onError(message)
      })
    },
    close() {
      if (closed) return
      closed = true
      void invoke('bridge_disconnect', { args: { bridgeId: ptyId } }).catch(() => {})
    },
  }
}
