import { describe, expect, it } from 'vitest'
import { buildSessionTreeGraph, sessionTreeEntryPreview, type NativeTreeNode } from './sessionTreeGraph'
import { nativeEntriesToUiMessages, type PiNativeEntry } from '../pi/nativeEntriesToMessages'

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
    expect(graph.edges.find(edge => edge.target === 'assistant-active')?.style).toMatchObject({ strokeWidth: 2.5 })
    expect(graph.edges.find(edge => edge.target === 'assistant-alternate')?.style).toMatchObject({ strokeWidth: 1.5 })
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

  it('hides tool result nodes and attaches the tool exchange to the next visible assistant', () => {
    const finalAssistant = messageNode('assistant-final', 'tool-result', 'assistant', 'The command passed')
    const toolResult: NativeTreeNode = {
      entry: {
        id: 'tool-result',
        parentId: 'assistant-tool',
        timestamp: '2026-01-01T00:00:02.000Z',
        type: 'message',
        message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false },
      },
      children: [finalAssistant],
    }
    const toolAssistant: NativeTreeNode = {
      entry: {
        id: 'assistant-tool',
        parentId: 'user',
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'npm test' } }] },
      },
      children: [toolResult],
    }
    const root = messageNode('user', null, 'user', 'Run the tests', [toolAssistant])
    const graph = buildSessionTreeGraph([root], 'assistant-final', label)

    expect(graph.nodes.map(node => node.id)).toEqual(['user', 'assistant-final'])
    expect(graph.nodes.find(node => node.id === 'assistant-final')?.data.toolCount).toBe(1)
    expect(graph.detailEntriesById.get('assistant-final')?.map(entry => entry.id)).toEqual([
      'assistant-tool', 'tool-result', 'assistant-final',
    ])
    const messages = nativeEntriesToUiMessages(
      graph.detailEntriesById.get('assistant-final') as PiNativeEntry[],
      { sessionId: 'session', directory: '/workspace' },
    )
    expect(messages.flatMap(message => message.parts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', tool: 'bash' }),
    ]))
  })

  it('keeps tool results isolated across sibling branches', () => {
    const resultA: NativeTreeNode = {
      entry: { id: 'result-a', parentId: 'assistant-tool', type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', content: 'A', isError: false } },
      children: [messageNode('final-a', 'result-a', 'assistant', 'Answer A')],
    }
    const resultB: NativeTreeNode = {
      entry: { id: 'result-b', parentId: 'assistant-tool', type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', content: 'B', isError: true } },
      children: [messageNode('final-b', 'result-b', 'assistant', 'Answer B')],
    }
    const toolAssistant: NativeTreeNode = {
      entry: { id: 'assistant-tool', parentId: 'user', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }] } },
      children: [resultA, resultB],
    }
    const graph = buildSessionTreeGraph([messageNode('user', null, 'user', 'Run', [toolAssistant])], 'final-b', label)

    expect(graph.detailEntriesById.get('final-a')?.map(entry => entry.id)).toEqual(['assistant-tool', 'result-a', 'final-a'])
    expect(graph.detailEntriesById.get('final-b')?.map(entry => entry.id)).toEqual(['assistant-tool', 'result-b', 'final-b'])
    expect(graph.nodes.find(node => node.id === 'final-a')?.data.hasToolError).toBe(false)
    expect(graph.nodes.find(node => node.id === 'final-b')?.data.hasToolError).toBe(true)
  })

  it('keeps hidden tool activity in the visual current node detail', () => {
    const result: NativeTreeNode = {
      entry: { id: 'result', parentId: 'assistant-tool', type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', content: 'done', isError: false } },
      children: [],
    }
    const toolAssistant: NativeTreeNode = {
      entry: { id: 'assistant-tool', parentId: 'user', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }] } },
      children: [result],
    }
    const graph = buildSessionTreeGraph([messageNode('user', null, 'user', 'Run', [toolAssistant])], 'result', label)

    expect(graph.nodes.find(node => node.id === 'user')?.data.currentLeaf).toBe(true)
    expect(graph.nodes.find(node => node.id === 'user')?.data.toolCount).toBe(1)
    expect(graph.detailEntriesById.get('user')?.map(entry => entry.id)).toEqual(['user', 'assistant-tool', 'result'])
  })

  it('treats whitespace-only assistant text as hidden tool activity', () => {
    const whitespaceAssistant: NativeTreeNode = {
      entry: {
        id: 'assistant-space',
        parentId: 'user',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: '  \n ' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }] },
      },
      children: [messageNode('assistant-final', 'assistant-space', 'assistant', 'Done')],
    }
    const graph = buildSessionTreeGraph([messageNode('user', null, 'user', 'Read', [whitespaceAssistant])], 'assistant-final', label)

    expect(graph.nodes.map(node => node.id)).toEqual(['user', 'assistant-final'])
    expect(graph.detailEntriesById.get('assistant-final')?.map(entry => entry.id)).toEqual(['assistant-space', 'assistant-final'])
  })
})
