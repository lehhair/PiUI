import type { PiNativeEntriesPageV1, SessionSnapshotV1 } from '@piui/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { messageStore } from '../store/messageStore'
import { nativeSessionStore } from './nativeSessionStore'

const { fetchSnapshotMock, fetchBranchMock } = vi.hoisted(() => ({
  fetchSnapshotMock: vi.fn(),
  fetchBranchMock: vi.fn(),
}))

vi.mock('./sessionApi', () => ({
  fetchSnapshot: (...args: unknown[]) => fetchSnapshotMock(...args),
  fetchPiNativeBranchPage: (...args: unknown[]) => fetchBranchMock(...args),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const snapshot = {
  epoch: 'registry-epoch',
  sequence: 2,
  session: { id: 'streaming-session', directory: '/workspace', state: 'running' },
  runtime: { isStreaming: true },
  native: {
    namespace: 'pi', schemaVersion: 1, sdkVersion: 'test', revision: 2,
    epoch: 'epoch', header: null, leafId: 'u1', entryCount: 1,
  },
} as SessionSnapshotV1

const page: PiNativeEntriesPageV1 = {
  head: snapshot.native,
  items: [{ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'hello' } }],
  checkpoint: { position: { epoch: 'worker-epoch', sequence: 0 } },
  hasMore: false,
}

describe('loadPiSessionToUi during streaming', () => {
  beforeEach(() => {
    messageStore.clearAll()
    nativeSessionStore.clear()
    fetchSnapshotMock.mockReset().mockResolvedValue(snapshot)
    fetchBranchMock.mockReset()
  })

  it('applies the snapshot before the native branch request completes', async () => {
    const branch = deferred<PiNativeEntriesPageV1>()
    fetchBranchMock.mockReturnValue(branch.promise)
    const { loadPiSessionToUi } = await import('./applySnapshot')

    const loading = loadPiSessionToUi('streaming-session')
    await vi.waitFor(() => expect(nativeSessionStore.getSnapshot('streaming-session')).toBe(snapshot))
    expect(nativeSessionStore.hasNativePage('streaming-session')).toBe(false)

    branch.resolve(page)
    await loading
    expect(nativeSessionStore.hasNativePage('streaming-session')).toBe(true)
    expect(messageStore.getVisibleMessages('streaming-session')).toHaveLength(1)
  })
})
