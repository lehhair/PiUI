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

/** 桥连接 open 看门狗：超时仍未收到 open 事件则主动失败让调用方重连 */
const WS_BRIDGE_OPEN_TIMEOUT_MS = 8_000

export interface PiSocket {
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
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
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
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
      // 首次 webview 会话的 IPC 偶发不可靠：invoke 悬挂或事件不送达时，
      // 靠 open 看门狗主动失败一次，让调用方的重连逻辑用全新的 Channel/
      // invoke 重试（等价于一次刷新）。
      let watchdogFired = false
      const openWatchdog = window.setTimeout(() => {
        if (this.readyState !== 0) return
        watchdogFired = true
        this.readyState = PI_SOCKET_CLOSED
        this.onerror?.()
        this.onclose?.({ code: 1006 })
      }, WS_BRIDGE_OPEN_TIMEOUT_MS)
      const id = await invoke<number>('ws_bridge_connect', { url, onEvent: channel })
      clearTimeout(openWatchdog)
      if (watchdogFired || this.closedByUs) {
        // 看门狗已判死：这条 Rust 连接不再需要，及时关掉避免泄漏。
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
      if (import.meta.env.DEV) console.debug('[PiSocket] bridge error:', event.message)
      this.onerror?.()
      return
    }
    if (this.readyState === PI_SOCKET_CLOSED) return
    this.readyState = PI_SOCKET_CLOSED
    this.onclose?.({ code: event.code ?? 1006, reason: event.reason })
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
