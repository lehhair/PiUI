import { describe, expect, it } from 'vitest'
import { filterPiSessionList, linkPiSessionForks, piSessionInfoToUiSession } from './nativeSessionListModel'

describe('Pi session list model', () => {
  it('uses an explicit name as title while preserving Pi metadata', () => {
    expect(piSessionInfoToUiSession({
      id: 's1',
      path: '/sessions/s1.jsonl',
      cwd: '/workspace/piui',
      name: 'Registry refactor',
      firstMessage: 'Please review the API',
      allMessagesText: 'Please review the API and tests',
      messageCount: 12,
      created: '2026-07-28T10:00:00.000Z',
      modified: '2026-07-29T10:00:00.000Z',
    })).toMatchObject({
      id: 's1',
      title: 'Registry refactor',
      firstMessage: 'Please review the API',
      directory: '/workspace/piui',
      messageCount: 12,
      isNamed: true,
      path: '/sessions/s1.jsonl',
    })
  })

  it('falls back to the first user message and searches message text', () => {
    const session = piSessionInfoToUiSession({
      id: 's2',
      path: '/sessions/s2.jsonl',
      cwd: '/workspace/demo',
      firstMessage: 'Fix the parser',
      allMessagesText: 'Fix the parser regression in JSON mode',
      messageCount: 4,
    })!
    expect(session.title).toBe('Fix the parser')
    expect(filterPiSessionList([session], 'regression')).toEqual([session])
  })

  it('drops malformed entries that cannot be opened', () => {
    expect(piSessionInfoToUiSession({ id: 'missing-cwd' })).toBeNull()
  })

  it('links fork metadata without changing list order', () => {
    const parent = piSessionInfoToUiSession({
      id: 'parent',
      path: 'C:\\sessions\\parent.jsonl',
      cwd: 'C:\\repo',
      name: 'Main approach',
    })!
    const fork = piSessionInfoToUiSession({
      id: 'fork',
      path: 'C:\\sessions\\fork.jsonl',
      parentSessionPath: 'c:\\sessions\\parent.jsonl',
      cwd: 'C:\\repo',
      firstMessage: 'Try another approach',
    })!
    const linked = linkPiSessionForks([fork, parent])
    expect(linked.map(session => session.id)).toEqual(['fork', 'parent'])
    expect(linked[0]).toMatchObject({ forkParentId: 'parent', forkParentTitle: 'Main approach' })
  })
})
