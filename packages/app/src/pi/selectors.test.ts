import { describe, expect, it } from 'vitest'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { PiBranchPage, PiBashExecutionGroupItem, PiTimelineItem } from './domain/index.js'
import { selectPiTimelineItems } from './selectors/index.js'

function bashEntry(id: string, command: string): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'bashExecution', command, output: 'out', exitCode: 0, timestamp: Date.now() },
  } as SessionEntry
}

function userEntry(id: string, text: string): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: text },
  } as SessionEntry
}

function page(entries: SessionEntry[]): PiBranchPage {
  return {
    head: {
      sdkVersion: '0.84.0',
      revision: entries.length,
      header: null,
      leafId: entries[entries.length - 1]?.id ?? null,
      entryCount: entries.length,
      epoch: 'epoch-1',
    },
    items: entries,
    beforeCursor: undefined,
    hasMore: false,
  }
}

describe('selectPiTimelineItems bash grouping', () => {
  it('merges consecutive bash executions into one tool group', () => {
    const items = selectPiTimelineItems(page([bashEntry('b1', 'ls'), bashEntry('b2', 'pwd'), bashEntry('b3', 'git status')]))
    expect(items).toHaveLength(1)
    const group = items[0] as PiBashExecutionGroupItem
    expect(group.kind).toBe('bash_execution_group')
    expect(group.entryId).toBe('b1')
    expect(group.items.map(item => item.entryId)).toEqual(['b1', 'b2', 'b3'])
  })

  it('keeps bash groups separate when interrupted by other entries', () => {
    const items = selectPiTimelineItems(page([bashEntry('b1', 'ls'), userEntry('u1', 'hi'), bashEntry('b2', 'pwd')]))
    const groups = items.filter(item => item.kind === 'bash_execution_group') as PiBashExecutionGroupItem[]
    expect(groups).toHaveLength(2)
    expect(groups[0].items.map(item => item.entryId)).toEqual(['b1'])
    expect(groups[1].items.map(item => item.entryId)).toEqual(['b2'])
  })

  it('wraps a single bash execution in a group with stable entryId', () => {
    const items = selectPiTimelineItems(page([bashEntry('b1', 'ls')]))
    expect(items).toHaveLength(1)
    const group = items[0] as PiBashExecutionGroupItem
    expect(group.kind).toBe('bash_execution_group')
    expect(group.entryId).toBe('b1')
    expect(group.items).toHaveLength(1)
  })

  it('does not merge bash across compaction entries', () => {
    const compaction = {
      type: 'compaction',
      id: 'c1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
      summary: 'sum',
      tokensBefore: 10,
      firstKeptEntryId: 'b1',
    } as unknown as SessionEntry
    const items = selectPiTimelineItems(page([bashEntry('b1', 'ls'), compaction, bashEntry('b2', 'pwd')]))
    const groups = items.filter(item => item.kind === 'bash_execution_group') as PiBashExecutionGroupItem[]
    expect(groups).toHaveLength(2)
  })

  it('preserves relative order with user/assistant entries', () => {
    const items = selectPiTimelineItems(page([bashEntry('b1', 'ls'), userEntry('u1', 'hi')]))
    expect(items.map(item => item.kind)).toEqual(['bash_execution_group', 'user_message'])
    expect((items[0] as PiTimelineItem).entryId).toBe('b1')
  })
})

describe('selectPiTimelineItems live/persisted key handover', () => {
  const assistantEntry = (id: string, text: string) => ({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'm',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  }) as SessionEntry

  function branchWith(checkpoint: PiBranchPage['checkpoint'], client?: PiBranchPage['client']): PiBranchPage {
    const entries = [userEntry('u1', 'hi'), assistantEntry('a1', 'done')]
    return {
      ...page(entries),
      checkpoint,
      client,
    }
  }

  it('does not render the live row once its persisted entry is visible via stableEntryIds', () => {
    // persisted entry a1 is mapped back to live.id as renderKey (branchMerge
    // sets stableEntryIds.a1 = 'live-a1') — rendering the live row too would
    // produce two children with the same key.
    const branch = branchWith(
      {
        position: { epoch: 'epoch-1', sequence: 3 },
        liveMessage: {
          id: 'live-a1',
          revision: 3,
          phase: 'persisting',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'm',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        },
      },
      { stableEntryIds: { a1: 'live-a1' } },
    )
    const items = selectPiTimelineItems(branch)
    // Only the persisted entry renders (no live duplicate).
    expect(items.filter(i => i.kind === 'assistant_message')).toHaveLength(1)
    expect(items.some(i => i.kind === 'assistant_message' && i.entryId === 'live-a1')).toBe(false)
    const persisted = items.find(i => i.kind === 'assistant_message' && i.entryId === 'a1')
    expect(persisted?.renderKey).toBe('live-a1')
  })

  it('still renders a persisting live row while its entry is not yet visible', () => {
    const branch = branchWith({
      position: { epoch: 'epoch-1', sequence: 3 },
      liveMessage: {
        id: 'live-a1',
        revision: 3,
        phase: 'persisting',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'm',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: Date.now(),
        },
      },
    })
    const items = selectPiTimelineItems(branch)
    expect(items.some(i => i.kind === 'assistant_message' && i.entryId === 'live-a1' && i.isStreaming)).toBe(true)
  })
})
