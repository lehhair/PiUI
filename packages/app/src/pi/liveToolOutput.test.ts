import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractToolExecutionText, liveToolOutputStore } from './liveToolOutput'

describe('extractToolExecutionText', () => {
  it('joins text blocks from a Pi partialResult', () => {
    expect(extractToolExecutionText({ content: [
      { type: 'text', text: 'total 48\n' },
      { type: 'text', text: 'drwxr-xr-x src' },
    ] })).toBe('total 48\ndrwxr-xr-x src')
  })

  it('ignores non-text blocks and malformed input', () => {
    expect(extractToolExecutionText({ content: [{ type: 'image', data: 'x' }] })).toBe('')
    expect(extractToolExecutionText(undefined)).toBe('')
    expect(extractToolExecutionText({ content: 'nope' })).toBe('')
  })
})

describe('liveToolOutputStore', () => {
  beforeEach(() => liveToolOutputStore.clearAll())

  it('stores, reads and clears per tool call', () => {
    expect(liveToolOutputStore.get('call-1')).toBeUndefined()
    liveToolOutputStore.set('call-1', 'session-1', 'building...')
    expect(liveToolOutputStore.get('call-1')).toBe('building...')
    liveToolOutputStore.delete('call-1')
    expect(liveToolOutputStore.get('call-1')).toBeUndefined()
  })

  it('replaces the accumulated output instead of appending', () => {
    liveToolOutputStore.set('call-1', 'session-1', 'step 1')
    liveToolOutputStore.set('call-1', 'session-1', 'step 1\nstep 2')
    expect(liveToolOutputStore.get('call-1')).toBe('step 1\nstep 2')
  })

  it('clears all outputs of a session without touching others', () => {
    liveToolOutputStore.set('call-a', 'session-1', 'a')
    liveToolOutputStore.set('call-b', 'session-2', 'b')
    liveToolOutputStore.clearSession('session-1')
    expect(liveToolOutputStore.get('call-a')).toBeUndefined()
    expect(liveToolOutputStore.get('call-b')).toBe('b')
  })

  it('notifies subscribers on changes', () => {
    const listener = vi.fn()
    const unsubscribe = liveToolOutputStore.subscribe(listener)
    liveToolOutputStore.set('call-1', 'session-1', 'x')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    liveToolOutputStore.delete('call-1')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
