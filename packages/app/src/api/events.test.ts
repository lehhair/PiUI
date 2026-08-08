import { describe, expect, it, vi } from 'vitest'
import { subscribeToConnectionState } from './events'

describe('connection state', () => {
  it('does not start a browser SSE request in PiUI mode', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const unsubscribe = subscribeToConnectionState(() => {})

    expect(fetchSpy).not.toHaveBeenCalled()

    unsubscribe()
    fetchSpy.mockRestore()
  })
})
