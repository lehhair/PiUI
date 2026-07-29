import { describe, expect, it } from 'vitest'
import { buildSessionTreeGraph, sessionTreeEntryPreview, type NativeTreeNode } from './sessionTreeGraph'

const label = (type: string) => type

function messageNode(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  text: string,
  children: NativeTreeNode[] = [],
): NativeTreeNode {
  return {
    entry: {
      id,
      parentId,
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      message: { role, content: [{ type: 'text', text }] },
    },
    children,
  }
}

describe('buildSessionTreeGraph', () => {
  it('lays branches out in two dimensions and marks the active path', () => {
    const active = messageNode('assistant-active', 'user-root', 'assistant', 'Active answer')
    const alternate = messageNode('assistant-alternate', 'user-root', 'assistant', 'Alternate answer')
    const root = messageNode('user-root', null, 'user', 'Choose an implementation', [active, alternate])

    const graph = buildSessionTreeGraph([root], 'assistant-active', label)
    const rootNode = graph.nodes.find(node => node.id === 'user-root')!
    const activeNode = graph.nodes.find(node => node.id === 'assistant-active')!
    const alternateNode = graph.nodes.find(node => node.id === 'assistant-alternate')!

    expect(rootNode.position.y).toBeLessThan(activeNode.position.y)
    expect(activeNode.position.x).not.toBe(alternateNode.position.x)
    expect(rootNode.data.branchCount).toBe(2)
    expect(rootNode.data.activePath).toBe(true)
    expect(activeNode.data.currentLeaf).toBe(true)
    expect(alternateNode.data.activePath).toBe(false)
    expect(graph.edges.find(edge => edge.target === 'assistant-active')?.style).toMatchObject({ strokeWidth: 2 })
    expect(graph.edges.find(edge => edge.target === 'assistant-alternate')?.style).toMatchObject({ strokeWidth: 1 })
  })

  it('keeps multiple roots and normalizes long multiline previews', () => {
    const first = messageNode('root-a', null, 'user', `first\n${'x'.repeat(220)}`)
    const second = messageNode('root-b', null, 'assistant', 'second')
    const graph = buildSessionTreeGraph([first, second], null, label)

    expect(graph.nodes.map(node => node.id)).toEqual(['root-a', 'root-b'])
    expect(graph.edges).toHaveLength(0)
    expect(sessionTreeEntryPreview(first.entry, label)).not.toContain('\n')
    expect(sessionTreeEntryPreview(first.entry, label).length).toBeLessThanOrEqual(180)
    expect(sessionTreeEntryPreview(first.entry, label)).toMatch(/…$/)
  })

  it('hides control entries and reconnects messages to the nearest visible ancestor', () => {
    const assistant = messageNode('assistant', 'model-change', 'assistant', 'Done')
    const modelChange: NativeTreeNode = {
      entry: {
        id: 'model-change',
        parentId: 'user',
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'model_change',
        provider: 'test',
        modelId: 'model',
      },
      children: [assistant],
    }
    const root = messageNode('user', null, 'user', 'Change model and continue', [modelChange])
    const graph = buildSessionTreeGraph([root], 'model-change', label)

    expect(graph.nodes.map(node => node.id)).toEqual(['user', 'assistant'])
    expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'user', target: 'assistant' })]))
    expect(graph.nodes.find(node => node.id === 'user')?.data.currentLeaf).toBe(true)
  })
})
