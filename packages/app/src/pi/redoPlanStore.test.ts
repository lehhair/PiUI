import { afterEach, describe, expect, it } from 'vitest'
import { captureRedoCheckpoints, redoPlanStore } from './redoPlanStore'
import { piBranchStore } from './state/index.js'
import type { PiBranchPage } from './domain/index.js'

const SID = 'test-session'

function userEntry(id: string) {
  return { id, type: 'message', timestamp: 1, message: { role: 'user', content: [{ type: 'text', text: id }] } }
}

function assistantEntry(id: string) {
  return { id, type: 'message', timestamp: 1, message: { role: 'assistant', content: [{ type: 'text', text: id }] } }
}

function seedBranch(entries: Array<ReturnType<typeof userEntry>>) {
  piBranchStore.setData(SID, {
    items: entries,
    hasMore: false,
    beforeCursor: null,
    checkpoint: null,
  } as unknown as PiBranchPage)
}

afterEach(() => {
  piBranchStore.clear(SID)
})

describe('captureRedoCheckpoints', () => {
  it('captures the tail of the cut branch on same-branch undo', () => {
    seedBranch([userEntry('u1'), assistantEntry('a1'), userEntry('u2'), assistantEntry('a2')])
    expect(captureRedoCheckpoints(SID, 'u2')).toEqual(['a2'])
  })

  it('returns empty when the entry is not on the current branch', () => {
    seedBranch([userEntry('u1'), assistantEntry('a1')])
    expect(captureRedoCheckpoints(SID, 'other')).toEqual([])
  })
})

describe('redoPlanStore', () => {
  it('persists and rehydrates a plan through sessionStorage', () => {
    redoPlanStore.setPlan(SID, { epoch: 'e1', undoLeafId: 'a1', checkpoints: ['a2'], restored: 0 })
    expect(redoPlanStore.getPlan(SID)).toEqual({ epoch: 'e1', undoLeafId: 'a1', checkpoints: ['a2'], restored: 0 })
    redoPlanStore.setPlan(SID, null)
    expect(redoPlanStore.getPlan(SID)).toBeNull()
  })
})
