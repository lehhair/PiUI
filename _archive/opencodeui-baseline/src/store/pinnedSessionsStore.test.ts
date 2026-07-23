import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_SUFFIX = 'opencode-pinned-sessions'

function serverKey(serverId: string) {
  return `srv:${serverId}:${STORAGE_SUFFIX}`
}

function readPinned(serverId: string) {
  const raw = localStorage.getItem(serverKey(serverId))
  return raw ? (JSON.parse(raw) as unknown[]) : null
}

describe('pinnedSessionsStore', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.resetModules()
  })

  it('isolates pinned sessions per active server', async () => {
    const { serverStore } = await import('./serverStore')
    const remote = serverStore.addServer({ name: 'Remote', url: 'http://remote.example' })

    const { pinnedSessionsStore } = await import('./pinnedSessionsStore')

    pinnedSessionsStore.pin({
      sessionId: 'local-session',
      directory: '/local',
      title: 'Local Pin',
    })
    expect(pinnedSessionsStore.isPinned('local-session')).toBe(true)

    serverStore.setActiveServer(remote.id)
    expect(pinnedSessionsStore.isPinned('local-session')).toBe(false)

    pinnedSessionsStore.pin({
      sessionId: 'remote-session',
      directory: '/remote',
      title: 'Remote Pin',
    })
    expect(readPinned(remote.id)).toEqual([
      { sessionId: 'remote-session', directory: '/remote', title: 'Remote Pin' },
    ])
    expect(readPinned('local')).toEqual([
      { sessionId: 'local-session', directory: '/local', title: 'Local Pin' },
    ])

    serverStore.setActiveServer('local')
    expect(pinnedSessionsStore.isPinned('local-session')).toBe(true)
    expect(pinnedSessionsStore.isPinned('remote-session')).toBe(false)
  })

  it('migrates legacy global pins to the current server once', async () => {
    localStorage.setItem(
      STORAGE_SUFFIX,
      JSON.stringify([{ sessionId: 'legacy-1', directory: '/old', title: 'Legacy' }]),
    )

    const { pinnedSessionsStore } = await import('./pinnedSessionsStore')

    expect(pinnedSessionsStore.getSnapshot()).toEqual([
      { sessionId: 'legacy-1', directory: '/old', title: 'Legacy' },
    ])
    expect(readPinned('local')).toEqual([
      { sessionId: 'legacy-1', directory: '/old', title: 'Legacy' },
    ])
    expect(localStorage.getItem(STORAGE_SUFFIX)).toBeNull()
  })
})
