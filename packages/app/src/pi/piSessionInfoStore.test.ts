import { beforeEach, describe, expect, it } from 'vitest'
import type { PiNativeSessionInfo } from './nativeApi'
import { piSessionInfoStore } from './piSessionInfoStore'

const session = (id: string, cwd: string): PiNativeSessionInfo => ({
  id,
  path: `${cwd}/${id}.jsonl`,
  cwd,
  created: '2026-07-28T10:00:00.000Z',
  modified: '2026-07-29T10:00:00.000Z',
  firstMessage: id,
  allMessagesText: id,
  messageCount: 1,
})

describe('Pi session info store', () => {
  beforeEach(() => piSessionInfoStore.clear())

  it('retains raw global and cwd-scoped Pi SessionInfo', () => {
    const global = [session('a', 'C:\\Repo'), session('b', 'D:\\Other')]
    const scoped = [global[0]!]

    piSessionInfoStore.replaceAll(global)
    piSessionInfoStore.replaceForCwd('c:\\repo', scoped)

    expect(piSessionInfoStore.getAll()).toBe(global)
    expect(piSessionInfoStore.getForCwd('C:\\REPO')).toBe(scoped)
    expect(piSessionInfoStore.getAll()[0]).not.toHaveProperty('directory')
    expect(piSessionInfoStore.getAll()[0]).not.toHaveProperty('title')
  })
})
