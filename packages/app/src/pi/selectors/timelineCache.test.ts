import { describe, expect, it, beforeEach } from 'vitest'
import { selectPiTimelineItemsCached, clearPiTimelineItemCache } from './timelineCache'
import type { PiBranchPage, PiTimelineItem } from '../domain/index.js'
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent'

function rawEntry(id: string, timestamp = 1, role: 'user' | 'assistant' = 'user'): SessionMessageEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: (role === 'user'
      ? { role: 'user', content: `hello ${id}`, timestamp }
      : { role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp }
    ) as SessionMessageEntry['message'],
  }
}

function branch(items: SessionMessageEntry[]): PiBranchPage {
  return {
    items,
    head: { sdkVersion: '0.84.1', revision: 1, header: null, leafId: 'leaf', entryCount: items.length, epoch: 'e1' },
    hasMore: false,
    beforeCursor: undefined,
    checkpoint: undefined,
  }
}

const user1 = rawEntry('u1', 1, 'user')
const user2 = rawEntry('u2', 2, 'user')
const assistant1 = rawEntry('a1', 3, 'assistant')

function firstUser(items: PiTimelineItem[]): PiTimelineItem | undefined {
  return items.find(item => item.kind === 'user_message')
}

describe('selectPiTimelineItemsCached', () => {
  beforeEach(() => clearPiTimelineItemCache())

  it('returns the same array reference when the branch page reference is unchanged', () => {
    const page = branch([user1, user2])
    const first = selectPiTimelineItemsCached('s1', page)
    const second = selectPiTimelineItemsCached('s1', page)
    expect(second).toBe(first)
  })

  it('reuses history item objects across streaming chunks (only checkpoint changes)', () => {
    // First build: full branch with history.
    const page = branch([user1, assistant1])
    const first = selectPiTimelineItemsCached('s1', page)
    const firstUserItem = firstUser(first)
    expect(firstUserItem).toBeDefined()

    // Streaming chunk: same page reference (updateLiveMessage shallow-copies
    // the page and only replaces checkpoint.liveMessage).
    const streamingChunk = selectPiTimelineItemsCached('s1', page)
    expect(streamingChunk).toBe(first)
    expect(firstUser(streamingChunk)).toBe(firstUserItem)
  })

  it('rebuilds when the branch reference changes (refresh merged new entries)', () => {
    const oldPage = branch([user1])
    const oldItems = selectPiTimelineItemsCached('s1', oldPage)

    const newPage = branch([user1, user2])
    const newItems = selectPiTimelineItemsCached('s1', newPage)
    expect(newItems).not.toBe(oldItems)
    expect(newItems.length).toBe(oldItems.length + 1)
  })

  it('returns empty for null branch and counts items for null session', () => {
    expect(selectPiTimelineItemsCached(null, null)).toEqual([])
    expect(selectPiTimelineItemsCached(null, branch([user1]))).toHaveLength(1)
  })

  it('isolates caches per session', () => {
    const pageA = branch([user1])
    const pageB = branch([user2])
    const itemsA = selectPiTimelineItemsCached('session-a', pageA)
    const itemsB = selectPiTimelineItemsCached('session-b', pageB)
    expect(firstUser(itemsA)?.entryId).toBe('u1')
    expect(firstUser(itemsB)?.entryId).toBe('u2')
  })
})

describe('selectPiTimelineItemsCached streaming (items identity)', () => {
  beforeEach(() => clearPiTimelineItemCache())

  it('keeps history item references stable while the live message updates (token storm)', () => {
    const items = [user1, assistant1]
    const page1 = branch(items)
    const first = selectPiTimelineItemsCached('s1', page1)
    const firstUserItem = firstUser(first)

    // updateLiveMessage: setData(sessionId, { ...data, checkpoint: {...} }) —
    // new page reference, same items array reference, new liveMessage.
    const page2 = { ...page1, checkpoint: { position: { epoch: 'e1', sequence: 2 }, liveMessage: { id: 'live-1', revision: 2, phase: 'streaming' as const, message: { role: 'user' as const, content: 'hi', timestamp: 2 } } } } as PiBranchPage
    const second = selectPiTimelineItemsCached('s1', page2)
    // History item references are reused — memoized rows hold.
    expect(firstUser(second)).toBe(firstUserItem)
    // The live user message shows up as a fresh item.
    expect(second.length).toBe(first.length + 1)
    const liveItem = second[second.length - 1]
    expect(liveItem.kind).toBe('user_message')
    expect(liveItem.entryId).toBe('live-1')
  })

  it('rebuilds when the items array reference changes (branch.get refresh)', () => {
    const page1 = branch([user1])
    const old = selectPiTimelineItemsCached('s1', page1)

    const newItems = [user1, user2]
    const page2 = branch(newItems)
    const next = selectPiTimelineItemsCached('s1', page2)
    expect(next).not.toBe(old)
    expect(next.length).toBe(2)
  })

  it('updates the live assistant message content across chunks without touching history', () => {
    const items = [user1]
    const page1 = branch(items)
    const first = selectPiTimelineItemsCached('s1', page1)
    const firstUserItem = firstUser(first)

    const chunk1 = { ...page1, checkpoint: { position: { epoch: 'e1', sequence: 2 }, liveMessage: { id: 'live-a1', revision: 2, phase: 'streaming' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Hel' }], timestamp: 2 } } } } as PiBranchPage
    const items1 = selectPiTimelineItemsCached('s1', chunk1)
    expect(firstUser(items1)).toBe(firstUserItem)
    expect(items1.length).toBe(2)
    expect((items1[1] as { message: { content: { text: string }[] } }).message.content[0]?.text).toBe('Hel')

    const chunk2 = { ...page1, checkpoint: { position: { epoch: 'e1', sequence: 3 }, liveMessage: { id: 'live-a1', revision: 3, phase: 'streaming' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Hello' }], timestamp: 3 } } } } as PiBranchPage
    const items2 = selectPiTimelineItemsCached('s1', chunk2)
    expect(firstUser(items2)).toBe(firstUserItem)
    expect(items2.length).toBe(2)
    expect((items2[1] as { message: { content: { text: string }[] } }).message.content[0]?.text).toBe('Hello')
  })
})
