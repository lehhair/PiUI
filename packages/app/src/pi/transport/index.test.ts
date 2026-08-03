import { afterEach, describe, expect, it, vi } from 'vitest'
import { getHostTerminalWebSocketUrl } from './index.js'
import { serverStore } from '../../store/serverStore'

describe('getHostTerminalWebSocketUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('includes ticket and cursor query params', () => {
    vi.spyOn(serverStore, 'getActiveToken').mockReturnValue(undefined)
    const url = new URL(getHostTerminalWebSocketUrl('term-1', 'ticket-1', 42))
    expect(url.searchParams.get('ticket')).toBe('ticket-1')
    expect(url.searchParams.get('cursor')).toBe('42')
  })

  it('appends token query param when a token is configured (same-origin browser)', () => {
    vi.spyOn(serverStore, 'getActiveToken').mockReturnValue('secret-token')
    const url = new URL(getHostTerminalWebSocketUrl('term-1', 'ticket-1'))
    expect(url.searchParams.get('token')).toBe('secret-token')
  })

  it('omits token param when no token is configured', () => {
    vi.spyOn(serverStore, 'getActiveToken').mockReturnValue(undefined)
    const url = new URL(getHostTerminalWebSocketUrl('term-1', 'ticket-1'))
    expect(url.searchParams.has('token')).toBe(false)
  })
})
