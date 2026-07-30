import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  abortSession,
  createSession,
  deleteSession,
  getSessionDiff,
  getSessions,
  getSessionStatus,
  getSessionTodos,
  updateSession,
} from './session'

const mocks = vi.hoisted(() => ({
  abortSessionCommand: vi.fn(),
  createPiSession: vi.fn(),
  deletePiSession: vi.fn(),
  fetchSnapshot: vi.fn(),
  listPiSessions: vi.fn(),
  resolveWorkspacePath: vi.fn(),
  setPiSessionName: vi.fn(),
  applySnapshotToUi: vi.fn(),
}))

vi.mock('../pi/sessionApi', () => ({
  abortSessionCommand: mocks.abortSessionCommand,
  createPiSession: mocks.createPiSession,
  deletePiSession: mocks.deletePiSession,
  fetchSnapshot: mocks.fetchSnapshot,
  listPiSessions: mocks.listPiSessions,
  setPiSessionName: mocks.setPiSessionName,
}))

vi.mock('../pi/workspaces', () => ({
  resolveWorkspacePath: mocks.resolveWorkspacePath,
}))

vi.mock('../pi/applySnapshot', () => ({ applySnapshotToUi: mocks.applySnapshotToUi }))

function snapshot(id: string, state: 'idle' | 'running' = 'idle') {
  return {
    session: {
      id,
      directory: '/workspace',
      title: `Session ${id}`,
      state,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  } as never
}

describe('Pi session facade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveWorkspacePath.mockResolvedValue('/workspace')
  })

  it('filters Pi session summaries by workspace and search', async () => {
    mocks.listPiSessions.mockResolvedValue([
      {
        id: 'one',
        directory: '/workspace',
        title: 'Review changes',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
    ])

    await expect(getSessions({ directory: '/workspace', search: 'review' })).resolves.toEqual([
      expect.objectContaining({ id: 'one', directory: '/workspace' }),
    ])
    expect(mocks.listPiSessions).toHaveBeenCalledWith('/workspace')
  })

  it('creates, applies, and maps a Pi session snapshot', async () => {
    const created = snapshot('created')
    mocks.createPiSession.mockResolvedValue({ snapshot: created })

    await expect(createSession({ directory: '/workspace', title: 'Test' })).resolves.toEqual(
      expect.objectContaining({ id: 'created', title: 'Session created' }),
    )
    expect(mocks.createPiSession).toHaveBeenCalledWith({ workspacePath: '/workspace', title: 'Test' })
  })

  it('maps snapshot states and routes delete and abort through Pi', async () => {
    mocks.listPiSessions.mockResolvedValue([{ id: 'idle' }, { id: 'busy' }])
    mocks.fetchSnapshot.mockImplementation(async (id: string) => snapshot(id, id === 'idle' ? 'idle' : 'running'))
    mocks.abortSessionCommand.mockResolvedValue({
      snapshot: snapshot('busy'),
      cleared: { steering: [], followUp: [] },
    })

    await expect(getSessionStatus()).resolves.toEqual({ idle: { type: 'idle' }, busy: { type: 'busy' } })
    await expect(deleteSession('idle')).resolves.toBe(true)
    await expect(abortSession('busy')).resolves.toBe(true)
    expect(mocks.deletePiSession).toHaveBeenCalledWith('idle')
  })

  it('renames Pi sessions and reports legacy-only operations explicitly', async () => {
    const renamed = snapshot('session-1')
    mocks.setPiSessionName.mockResolvedValue({ snapshot: renamed })

    await expect(getSessionDiff('session-1')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(updateSession('session-1', { title: 'Renamed' }, '/workspace')).resolves.toEqual(
      expect.objectContaining({ id: 'session-1' }),
    )
    expect(mocks.setPiSessionName).toHaveBeenCalledWith('session-1', 'Renamed')
    await expect(updateSession('session-1', { archivedAt: Date.now() })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    })
    await expect(getSessionTodos('session-1')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })
})
