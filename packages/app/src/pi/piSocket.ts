import { isTauri } from '../utils/tauri'

/**
 * PiSocket：WebSocket 的最小抽象（open/message/close + readyState/send/close）。
 * 浏览器直接用原生 WebSocket；Tauri 下走 Rust WS 桥——WebView2 的 WebSocket
 * 会被系统代理劫持，本地回环连接表现为 TCP 层 ERR_CONNECTION_REFUSED，
 * 只能由 Rust 直连绕过。
 */
export const PI_SOCKET_OPEN = 1
export const PI_SOCKET_CLOSING = 2
export const PI_SOCKET_CLOSED = 3

export interface PiSocket {
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: (() => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

type BridgeEvent =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'close'; code?: number; reason?: string }
  | { type: 'error'; message?: string }

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

class TauriBridgeSocket implements PiSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0

  private id: number | null = null
  private closedByUs = false
  private pendingSends: string[] = []
  private invokeFn: TauriInvoke | null = null

  constructor(url: string) {
    void this.connect(url)
  }

  private async connect(url: string): Promise<void> {
    try {
      const { invoke, Channel } = await import('@tauri-apps/api/core')
      this.invokeFn = invoke as TauriInvoke
      const channel = new Channel<BridgeEvent>()
      channel.onmessage = event => this.handleEvent(event)
      const id = await invoke<number>('ws_bridge_connect', { url, onEvent: channel })
      if (this.closedByUs) {
        void invoke('ws_bridge_close', { id }).catch(() => undefined)
        return
      }
      this.id = id
      for (const data of this.pendingSends.splice(0)) this.send(data)
    } catch {
      if (this.closedByUs || this.readyState === PI_SOCKET_CLOSED) return
      this.readyState = PI_SOCKET_CLOSED
      this.onerror?.()
      this.onclose?.({ code: 1006 })
    }
  }

  private handleEvent(event: BridgeEvent): void {
    if (event.type === 'open') {
      if (this.readyState !== 0) return
      this.readyState = PI_SOCKET_OPEN
      this.onopen?.()
      return
    }
    if (event.type === 'message') {
      if (this.readyState !== PI_SOCKET_OPEN) return
      this.onmessage?.({ data: event.data })
      return
    }
    if (event.type === 'error') {
      this.onerror?.()
      return
    }
    if (this.readyState === PI_SOCKET_CLOSED) return
    this.readyState = PI_SOCKET_CLOSED
    this.onclose?.({ code: event.code ?? 1006 })
  }

  send(data: string): void {
    if (this.readyState !== PI_SOCKET_OPEN) return
    if (this.id === null || !this.invokeFn) {
      // open 事件可能先于 invoke 返回 id 到达，先缓冲
      this.pendingSends.push(data)
      return
    }
    const id = this.id
    void this.invokeFn('ws_bridge_send', { id, data }).catch(() => undefined)
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === PI_SOCKET_CLOSED) return
    this.closedByUs = true
    const id = this.id
    if (id !== null && this.invokeFn) {
      this.readyState = PI_SOCKET_CLOSING
      void this.invokeFn('ws_bridge_close', { id, code, reason }).catch(() => undefined)
      return
    }
    this.readyState = PI_SOCKET_CLOSED
  }
}

export function openPiSocket(url: string): PiSocket {
  if (!isTauri()) return new WebSocket(url) as unknown as PiSocket
  return new TauriBridgeSocket(url)
}
