import { describe, expect, it, vi } from 'vitest'
import { getSDKClient, UnsupportedPiCapabilityError } from './sdk'

describe('legacy API boundary', () => {
  it('fails explicitly without making a network request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const client = getSDKClient()

    expect(() => client.session.list({})).toThrow(UnsupportedPiCapabilityError)
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })
})
