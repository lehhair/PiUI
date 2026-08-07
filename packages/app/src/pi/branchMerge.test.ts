import { describe, expect, it } from 'vitest'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { PiBranchPage, PiLiveMessage } from './domain/index.js'
import { mergeLatestBranchPage } from './branchMerge.js'
import { selectPiTimelineItems } from './selectors/index.js'

function entry(id: string): SessionEntry {
  return { type: 'model_change', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', provider: 'p', modelId: id } as SessionEntry
}

function messageEntry(id: string, role: 'user' | 'assistant', text: string): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: role === 'user'
      ? { role, content: text }
      : { role, content: [{ type: 'text', text }] },
  } as SessionEntry
}

function page(ids: string[], overrides?: Partial<PiBranchPage>): PiBranchPage {
  return {
    head: {
      sdkVersion: '0.81.1',
      revision: ids.length,
      header: null,
      leafId: ids[ids.length - 1] ?? null,
      entryCount: ids.length,
      epoch: 'epoch-1',
    },
    items: ids.map(entry),
    beforeCursor: ids.length > 0 ? `cursor-before-${ids[0]}` : undefined,
    hasMore: false,
    ...overrides,
  }
}

describe('mergeLatestBranchPage', () => {
  it('takes latest when no current data', () => {
    const latest = page(['a', 'b'])
    expect(mergeLatestBranchPage(null, latest)).toBe(latest)
  })

  it('takes latest wholesale on epoch change', () => {
    const current = page(['a', 'b'], { hasMore: true, beforeCursor: 'old-cursor' })
    const latest = page(['x', 'y'], { head: { ...current.head, epoch: 'epoch-2' } })
    expect(mergeLatestBranchPage(current, latest)).toBe(latest)
  })

  it('replaces items when no pagination history exists', () => {
    const current = page(['a', 'b'])
    const latest = page(['a', 'b', 'c'])
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged.items.map(i => i.id)).toEqual(['a', 'b', 'c'])
    expect(merged).toBe(latest)
  })

  it('prepends older paginated items and keeps local cursor', () => {
    // User paged back: local holds [old1, old2, a, b]; latest page is [a, b, c]
    const current = page(['old1', 'old2', 'a', 'b'], { hasMore: true, beforeCursor: 'cursor-at-old1' })
    const latest = page(['a', 'b', 'c'])
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged.items.map(i => i.id)).toEqual(['old1', 'old2', 'a', 'b', 'c'])
    expect(merged.beforeCursor).toBe('cursor-at-old1')
    expect(merged.hasMore).toBe(true)
  })

  it('keeps items that fell out of the latest page window', () => {
    // Latest page only holds the most recent 2; local first item scrolled out
    const current = page(['a', 'b', 'c'])
    const latest = page(['b', 'c', 'd'])
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged.items.map(i => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('drops local history when branch structure changed (no overlap)', () => {
    const current = page(['a', 'b', 'c'], { hasMore: true, beforeCursor: 'old-cursor' })
    const latest = page(['x', 'y', 'z'])
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged).toBe(latest)
  })

  it('replaces wholesale when the local leaf is gone (tree navigation shrank the branch)', () => {
    // Navigate from d back to b: old branch [a,b,c,d] overlaps but its tail
    // must not survive as phantom entries.
    const current = page(['a', 'b', 'c', 'd'], { hasMore: true, beforeCursor: 'cursor-at-a' })
    const latest = page(['a', 'b'])
    const merged = mergeLatestBranchPage(current, latest)
    expect(merged).toBe(latest)
    expect(merged.items.map(i => i.id)).toEqual(['a', 'b'])
    expect(merged.hasMore).toBe(false)
  })

  it('keeps a live checkpoint until its persisted entry appears', () => {
    const liveMessage = {
      id: 'live-user',
      revision: 2,
      phase: 'streaming' as const,
      message: { role: 'user', content: 'hello' },
    } as PiLiveMessage
    const current = page(['a'], { checkpoint: { position: { epoch: 'epoch-1', sequence: 2 }, liveMessage } })
    const latest = page(['a'])

    const merged = mergeLatestBranchPage(current, latest)

    expect(merged.checkpoint?.liveMessage?.id).toBe('live-user')
  })

  it('maps a persisted message back to its live render key', () => {
    const liveMessage = {
      id: 'live-assistant',
      revision: 2,
      phase: 'persisting' as const,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    } as PiLiveMessage
    const current = page(['user'], { checkpoint: { position: { epoch: 'epoch-1', sequence: 2 }, liveMessage } })
    const latest = page(['user', 'assistant'])
    latest.items[1] = messageEntry('assistant', 'assistant', 'done')

    const merged = mergeLatestBranchPage(current, latest)

    expect(merged.client?.stableEntryIds).toEqual({ assistant: 'live-assistant' })
    expect(selectPiTimelineItems(merged).find(item => item.entryId === 'assistant')?.renderKey).toBe('live-assistant')
  })
})
