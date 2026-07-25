import { describe, expect, it, vi } from 'vitest'
import { getConnectionInfo, subscribeToEvents } from './events'

describe('legacy SSE boundary', () => {
  it('does not start a browser SSE request in PiUI mode', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const unsubscribe = subscribeToEvents({ onError: vi.fn() })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getConnectionInfo().state).not.toBe('connecting')

    unsubscribe()
    fetchSpy.mockRestore()
  })
})
