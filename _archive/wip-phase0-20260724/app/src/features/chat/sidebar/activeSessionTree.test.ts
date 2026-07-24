import { describe, expect, it } from 'vitest'
import type { ActiveSessionEntry } from '../../../store/activeSessionStore'
import { buildActiveSessionTree } from './activeSessionTree'

function makeEntry(sessionId: string): ActiveSessionEntry {
  return {
    sessionId,
    status: { type: 'busy' },
  }
}

describe('buildActiveSessionTree', () => {
  it('nests active children under an active parent', () => {
    const root = makeEntry('root')
    const child = makeEntry('child')
    const grandchild = makeEntry('grandchild')

    const tree = buildActiveSessionTree([root, child, grandchild], sessionId => {
      if (sessionId === 'child') return 'root'
      if (sessionId === 'grandchild') return 'child'
      return undefined
    })

    expect(tree.rootEntries).toEqual([root])
    expect(tree.childrenByParent.get('root')).toEqual([child])
    expect(tree.childrenByParent.get('child')).toEqual([grandchild])
  })

  it('promotes an active child to the top level when its parent is not active', () => {
    const sibling = makeEntry('sibling')
    const childOnly = makeEntry('child-only')

    const tree = buildActiveSessionTree([sibling, childOnly], sessionId => {
      if (sessionId === 'child-only') return 'idle-parent'
      return undefined
    })

    expect(tree.rootEntries).toEqual([sibling, childOnly])
    expect(tree.childrenByParent.size).toBe(0)
  })
})
