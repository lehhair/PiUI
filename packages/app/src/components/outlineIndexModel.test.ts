import { describe, expect, it } from 'vitest'
import { buildOutlineSourceEntries } from './outlineIndexModel'
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
