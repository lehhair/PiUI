import { describe, expect, it } from 'vitest'
import { isSessionBusyError, isSessionNotFoundError } from './sessionErrors'

describe('isSessionNotFoundError', () => {
  it('recognizes the server session-not-found problem', () => {
    const error = Object.assign(new Error('session is not attached'), { code: 'SESSION_NOT_FOUND' })
    expect(isSessionNotFoundError(error)).toBe(true)
  })

  it('does not classify transient load failures as missing sessions', () => {
    expect(isSessionNotFoundError(new Error('Failed to fetch'))).toBe(false)
    expect(isSessionNotFoundError(Object.assign(new Error('server unavailable'), { status: 503 }))).toBe(false)
  })

  it('recognizes a session lock conflict separately', () => {
    expect(isSessionBusyError(Object.assign(new Error('lock is busy'), { code: 'SESSION_BUSY' }))).toBe(true)
    expect(isSessionBusyError(new Error('server unavailable'))).toBe(false)
  })
})
