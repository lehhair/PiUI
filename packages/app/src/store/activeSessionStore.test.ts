import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionSnapshotV1 } from '@piui/protocol'
import { activeSessionStore } from './activeSessionStore'

function snapshot(state: SessionSnapshotV1['session']['state']): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: 'epoch-1',
    sequence: 1,
    session: {
      id: 'pi-session',
      directory: '/workspace/project',
      driverId: 'pi',
      driverSessionId: 'pi-session',
      title: 'Active Pi session',
      state,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    runtime: {
      attached: true,
      thinkingLevel: 'off',
      availableThinkingLevels: ['off'],
      isStreaming: state === 'running',
      isCompacting: state === 'compacting',
      queue: { steering: [], followUp: [], steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time' },
      retry: state === 'retrying'
        ? {
            phase: 'waiting',
            autoEnabled: true,
            attempt: 2,
            maxAttempts: 3,
            delayMs: 1000,
            nextAttemptAt: '2026-01-01T00:00:01.000Z',
            errorMessage: 'overloaded',
          }
        : { phase: 'idle', autoEnabled: true },
      compaction: { autoEnabled: true, operation: { type: 'none' } },
      tools: [],
      activeTools: [],
    },
    timeline: [],
    timelinePage: { hasMore: false },
    native: { namespace: 'pi', schemaVersion: 1, sdkVersion: '0.81.1', revision: 1, epoch: 'test', header: null, leafId: null, entryCount: 0 },
  }
}

describe('activeSessionStore scoped refresh handling', () => {
  beforeEach(() => {
    activeSessionStore.initialize({})
    activeSessionStore.initializePendingRequests([], [])
  })

  it('preserves existing busy child sessions when merging scoped status refreshes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
      child: { type: 'busy' },
    })

    activeSessionStore.mergeStatusRefresh({
      root: { type: 'busy' },
    })

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['root', 'child'])
  })

  it('drops missing sessions on full status replacement refreshes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
      child: { type: 'busy' },
    })

    activeSessionStore.initialize({
      root: { type: 'busy' },
    })

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['root'])
  })

  it('keeps existing pending child requests during scoped pending refresh merges', () => {
    activeSessionStore.addPendingRequest('req-child', 'child', 'question', 'Need approval')

    activeSessionStore.mergePendingRequests([], [])

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['child'])
    expect(activeSessionStore.getBusySessions()[0]?.pendingAction).toEqual({
      type: 'question',
      description: 'Need approval',
    })
  })

  it('reuses the busySessions array reference when content is unchanged', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
    })
    activeSessionStore.setSessionMeta('root', 'Root', '/repo')

    const first = activeSessionStore.getBusySessionsSnapshot()
    activeSessionStore.mergeStatusRefresh({
      root: { type: 'busy' },
    })
    const second = activeSessionStore.getBusySessionsSnapshot()

    expect(second).toBe(first)
    expect(second).toEqual([
      {
        sessionId: 'root',
        status: { type: 'busy' },
        title: 'Root',
        directory: '/repo',
        pendingAction: undefined,
      },
    ])
  })

  it('replaces the busySessions array reference when status content changes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
    })
    const first = activeSessionStore.getBusySessionsSnapshot()

    activeSessionStore.updateStatus('root', {
      type: 'retry',
      attempt: 1,
      message: 'retrying',
      next: 1000,
    })
    const second = activeSessionStore.getBusySessionsSnapshot()

    expect(second).not.toBe(first)
    expect(second[0]?.status).toEqual({
      type: 'retry',
      attempt: 1,
      message: 'retrying',
      next: 1000,
    })
  })

  it('tracks Pi running, retrying, and idle snapshots', () => {
    activeSessionStore.syncPiSnapshot(snapshot('running'))
    expect(activeSessionStore.getBusySessions()).toEqual([
      expect.objectContaining({
        sessionId: 'pi-session',
        title: 'Active Pi session',
        directory: '/workspace/project',
        status: { type: 'busy' },
      }),
    ])

    activeSessionStore.syncPiSnapshot(snapshot('retrying'))
    expect(activeSessionStore.getBusySessions()[0]?.status).toEqual({
      type: 'retry',
      attempt: 2,
      message: 'overloaded',
      next: Date.parse('2026-01-01T00:00:01.000Z'),
    })

    activeSessionStore.syncPiSnapshot(snapshot('idle'))
    expect(activeSessionStore.getBusySessions()).toEqual([])
  })
})
