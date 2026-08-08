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
