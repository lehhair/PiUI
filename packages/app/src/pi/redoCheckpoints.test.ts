import { describe, expect, it } from 'vitest'
import { buildRedoCheckpoints } from './redoCheckpoints.js'

const user = (id: string) => ({ kind: 'user_message', entryId: id })
const assistant = (id: string) => ({ kind: 'assistant_message', entryId: id })
const custom = (id: string) => ({ kind: 'custom_message', entryId: id })
const bash = (id: string) => ({ kind: 'bash_execution', entryId: id })

describe('buildRedoCheckpoints', () => {
  it('marks the tail of every user turn in order', () => {
    const cut = [user('u1'), assistant('a1'), user('u2'), assistant('a2')]
    expect(buildRedoCheckpoints(cut)).toEqual(['a1', 'a2'])
  })

  it('ends the last checkpoint at the branch tip', () => {
    const cut = [user('u1'), assistant('a1'), bash('b1'), assistant('a2')]
    expect(buildRedoCheckpoints(cut)).toEqual(['a2'])
  })

  it('skips turns that have no non-user tail (bare user message cannot be a leaf)', () => {
    const cut = [user('u1'), user('u2'), assistant('a2')]
    expect(buildRedoCheckpoints(cut)).toEqual(['a2'])
  })

  it('returns empty when the cut tail is only user messages', () => {
    const cut = [user('u1'), user('u2')]
    expect(buildRedoCheckpoints(cut)).toEqual([])
  })

  it('treats custom_message as a turn start like the SDK does', () => {
    const cut = [custom('c1'), assistant('a1'), user('u2'), assistant('a2')]
    expect(buildRedoCheckpoints(cut)).toEqual(['a1', 'a2'])
  })

  it('walks back over consecutive turn starts to the real turn tail', () => {
    const cut = [user('u1'), assistant('a1'), user('u2'), custom('c2'), assistant('a2')]
    expect(buildRedoCheckpoints(cut)).toEqual(['a1', 'a2'])
  })

  it('keeps non-user entries between turns out of the checkpoints', () => {
    const cut = [user('u1'), bash('b1'), assistant('a1'), user('u2'), bash('b2')]
    expect(buildRedoCheckpoints(cut)).toEqual(['a1', 'b2'])
  })
})
