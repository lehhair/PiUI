import { describe, expect, it } from 'vitest'
import type { UiSession } from '../types/session'
import { flattenSessionHierarchy, hasSafeParentChain } from './sessionHierarchy'

const session = (id: string): UiSession => ({
  id,
  directory: '/repo',
  title: id,
  createdAt: 0,
  updatedAt: 0,
})

describe('session hierarchy', () => {
  it('flattens descendants iteratively and caps visual indentation', () => {
    const childrenByParent = new Map<string, UiSession[]>([
      ['root', [session('a')]],
      ['a', [session('b')]],
      ['b', [session('c')]],
      ['c', [session('d')]],
    ])
    const rows = flattenSessionHierarchy('root', childrenByParent.get('root')!, childrenByParent)
    expect(rows.map(row => [row.session.id, row.depth, row.visualDepth])).toEqual([
      ['a', 1, 1],
      ['b', 2, 2],
      ['c', 3, 3],
      ['d', 4, 3],
    ])
  })

  it('does not revisit a cycle', () => {
    const a = session('a')
    const b = session('b')
    const rows = flattenSessionHierarchy('root', [a], new Map([
      ['a', [b]],
      ['b', [a]],
    ]))
    expect(rows.map(row => row.session.id)).toEqual(['a', 'b'])
  })

  it('rejects cyclic and excessively deep parent chains', () => {
    expect(hasSafeParentChain('a', 'b', new Map([['b', 'a']]))).toBe(false)
    expect(hasSafeParentChain('a', 'b', new Map([['b', 'c'], ['c', 'd']]), 1)).toBe(false)
    expect(hasSafeParentChain('a', 'b', new Map([['b', 'c']]))).toBe(true)
  })
})
