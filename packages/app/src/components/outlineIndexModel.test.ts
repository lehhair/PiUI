import { describe, expect, it } from 'vitest'
import {
  buildOutlineSourceEntries,
  findBiasedVisibleIndex,
  resolveVisibleSectionIds,
} from './outlineIndexModel'
import type { PiUserMessageItem } from '../pi/domain/index.js'

function user(entryId: string, renderKey?: string): PiUserMessageItem {
  return {
    kind: 'user_message',
    entryId,
    renderKey,
    timestamp: 1,
    rawEntry: {} as never,
    message: { role: 'user', content: 'hello', timestamp: 1 },
    blocks: [{ type: 'text', text: 'hello' }],
  }
}

describe('buildOutlineSourceEntries', () => {
  it('uses the same stable anchor as the chat message row', () => {
    expect(buildOutlineSourceEntries([user('persisted-user', 'live-user')])).toEqual([
      { messageId: 'live-user', title: 'hello' },
    ])
  })
})

describe('resolveVisibleSectionIds', () => {
  const entries = [
    { messageId: 'u1', title: 'one' },
    { messageId: 'u2', title: 'two' },
    { messageId: 'u3', title: 'three' },
  ]
  const ownerMap = new Map<string, string>([
    ['u1', 'u1'],
    ['a1', 'u1'],
    ['t1', 'u1'],
    ['u2', 'u2'],
    ['a2', 'u2'],
  ])

  it('keeps direct user-prompt hits and resolves assistant/tool rows to their owner', () => {
    expect(resolveVisibleSectionIds(entries, ['u2', 'a1', 't1'], ownerMap).sort()).toEqual(['u1', 'u2'])
  })

  it('resolves rows even when the owning user prompt is not visible (assistant-only viewport)', () => {
    // 视口只看到第 3 节的助手/工具行，用户 prompt 行本身不可见
    const deepOwnerMap = new Map([...ownerMap, ['a3', 'u3'], ['t3', 'u3']])
    expect(resolveVisibleSectionIds(entries, ['a3', 't3'], deepOwnerMap)).toEqual(['u3'])
  })

  it('returns nothing for ids without an owner', () => {
    expect(resolveVisibleSectionIds(entries, ['unknown'], ownerMap)).toEqual([])
  })
})

describe('findBiasedVisibleIndex', () => {
  const entries = [
    { messageId: 'u1', title: 'one' },
    { messageId: 'u2', title: 'two' },
    { messageId: 'u3', title: 'three' },
  ]

  it('highlights the first (earlier) visible section when several are visible', () => {
    expect(findBiasedVisibleIndex(entries, new Set(['u2', 'u3']))).toBe(1)
  })

  it('returns -1 when nothing is visible', () => {
    expect(findBiasedVisibleIndex(entries, new Set())).toBe(-1)
    expect(findBiasedVisibleIndex(entries, new Set(['nope']))).toBe(-1)
  })
})
