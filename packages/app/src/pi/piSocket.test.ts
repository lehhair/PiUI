import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openPiSocket, PI_SOCKET_CLOSED, PI_SOCKET_OPEN } from './piSocket'

const { invokeMock, bridgeState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  bridgeState: { channel: null as { onmessage: ((event: unknown) => void) | null } | null },
}))

vi.mock('../utils/tauri', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null

    constructor() {
      bridgeState.channel = this
    }
  },
}))

describe('PiSocket Tauri bridge', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    bridgeState.channel = null
  })

  it('uses the Rust bridge for Android-compatible WebSocket traffic', async () => {
    invokeMock.mockResolvedValueOnce(7).mockResolvedValue(undefined)
    const socket = openPiSocket('ws://192.168.1.10:8787/api/v1/events?token=test')
    const onOpen = vi.fn()
    const onMessage = vi.fn()
    const onClose = vi.fn()
    socket.onopen = onOpen
    socket.onmessage = onMessage
    socket.onclose = onClose

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('ws_bridge_connect', expect.any(Object)))
    bridgeState.channel?.onmessage?.({ type: 'open' })
    expect(socket.readyState).toBe(PI_SOCKET_OPEN)
    expect(onOpen).toHaveBeenCalledOnce()

    socket.send('hello')
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('ws_bridge_send', { id: 7, data: 'hello' }))
    bridgeState.channel?.onmessage?.({ type: 'message', data: 'reply' })
    expect(onMessage).toHaveBeenCalledWith({ data: 'reply' })

    bridgeState.channel?.onmessage?.({ type: 'close', code: 1000, reason: 'done' })
    expect(socket.readyState).toBe(PI_SOCKET_CLOSED)
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: 'done' })
  })
})
