import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshotV1 } from '@piui/protocol'
import { SessionTreePanel } from './SessionTreePanel'
import { setPiCapabilities } from '../pi/capabilities'
import { nativeSessionStore } from '../pi/nativeSessionStore'
import {
  clearSessionEditorDraft,
  useSessionEditorDraft,
} from '../pi/sessionEditorDraftStore'

const mocks = vi.hoisted(() => ({
  applySnapshotToUi: vi.fn(),
  navigate: vi.fn(),
  setLabel: vi.fn(),
  fork: vi.fn(),
  clone: vi.fn(),
  importSession: vi.fn(),
  compact: vi.fn(),
  abortCompaction: vi.fn(),
  abortBranchSummary: vi.fn(),
  abortRetry: vi.fn(),
  clearQueue: vi.fn(),
  setAutoCompaction: vi.fn(),
  setAutoRetry: vi.fn(),
  setQueueModes: vi.fn(),
  setActiveTools: vi.fn(),
  fetchNativeTree: vi.fn(),
}))

vi.mock('../pi/applySnapshot', () => ({ applySnapshotToUi: mocks.applySnapshotToUi }))
vi.mock('./SessionTreeCanvas', () => ({
  SessionTreeCanvas: ({ graph, selectedEntryId, onSelectEntry }: {
    graph: { nodes: Array<{ id: string; data: { label?: string } }> }
    selectedEntryId: string | null
    onSelectEntry: (entryId: string) => void
  }) => (
    <div aria-label="Session Tree">
      {graph.nodes.map(node => (
        <button
          type="button"
          key={node.id}
          aria-pressed={selectedEntryId === node.id}
          onClick={() => onSelectEntry(node.id)}
        >
          {node.data.label ?? node.id}
        </button>
      ))}
    </div>
  ),
}))
vi.mock('../pi/sessionApi', () => ({
  navigatePiSessionTree: mocks.navigate,
  setPiSessionLabel: mocks.setLabel,
  forkPiSession: mocks.fork,
  clonePiSession: mocks.clone,
  importPiSession: mocks.importSession,
  compactSession: mocks.compact,
  abortPiCompaction: mocks.abortCompaction,
  abortPiBranchSummary: mocks.abortBranchSummary,
  abortPiRetry: mocks.abortRetry,
  clearPiQueue: mocks.clearQueue,
  setPiAutoCompaction: mocks.setAutoCompaction,
  setPiAutoRetry: mocks.setAutoRetry,
  setPiQueueModes: mocks.setQueueModes,
  setPiActiveTools: mocks.setActiveTools,
  fetchPiNativeTree: mocks.fetchNativeTree,
}))

function snapshot(id = 'session-1'): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: `epoch-${id}`,
    sequence: 1,
    session: {
      id,
      directory: '/workspace',
      driverId: 'pi',
      driverSessionId: id,
      state: 'idle',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    runtime: {
      attached: true,
      thinkingLevel: 'off',
      availableThinkingLevels: ['off'],
      isStreaming: false,
      isCompacting: false,
      queue: { steering: [], followUp: [], steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
      retry: { phase: "idle", autoEnabled: false },
      compaction: { autoEnabled: false, operation: { type: "none" } },
      tools: [],
      activeTools: [],
    },
    native: {
      namespace: 'pi',
      schemaVersion: 1,
      sdkVersion: '0.81.1',
      revision: 1,
      epoch: 'native-test',
      header: null,
      leafId: 'assistant-entry',
      entryCount: 3,
    },
  } as unknown as SessionSnapshotV1
}

function DraftProbe() {
  return <span data-testid="draft">{useSessionEditorDraft('session-1')?.text ?? ''}</span>
}

describe('SessionTreePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchNativeTree.mockResolvedValue([{
      entry: { id: 'user-entry', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Change the parser' }] } },
      children: [{
        entry: { id: 'assistant-entry', parentId: 'user-entry', timestamp: '2026-01-01T00:00:01.000Z', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Updated the parser' }] } },
        label: 'working branch',
        children: [],
      }],
    }])
    nativeSessionStore.clear()
    clearSessionEditorDraft('session-1')
    nativeSessionStore.replace(snapshot())
    setPiCapabilities({
      sessionTree: true,
      sessionNavigate: true,
      fork: true,
      sessionClone: true,
      sessionImport: true,
    })
  })

  it('navigates to an entry and applies its returned snapshot', async () => {
    const updated = { ...snapshot(), sequence: 2 }
    mocks.navigate.mockResolvedValue({ snapshot: updated, editorText: 'Change the parser' })
    render(<SessionTreePanel sessionId="session-1" />)

    fireEvent.click(await screen.findByText('user-entry'))
    const separator = screen.getByRole('separator', { name: 'Resize canvas and details' })
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal')
    expect(separator).toHaveAttribute('tabindex', '0')
    const min = Number(separator.getAttribute('aria-valuemin'))
    const max = Number(separator.getAttribute('aria-valuemax'))
    const now = Number(separator.getAttribute('aria-valuenow'))
    expect(now).toBeGreaterThanOrEqual(min)
    expect(now).toBeLessThanOrEqual(max)
    fireEvent.keyDown(separator, { key: 'ArrowDown' })
    fireEvent.click(screen.getByText('Return here'))

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('session-1', 'user-entry'))
    expect(mocks.applySnapshotToUi).toHaveBeenCalledWith(updated)
  })

  it('sets labels and follows a fork replacement target', async () => {
    const sourceSnapshot = snapshot()
    const targetSnapshot = snapshot('session-2')
    const onNavigateSession = vi.fn()
    mocks.setLabel.mockResolvedValue({ snapshot: { ...sourceSnapshot, sequence: 2 } })
    mocks.fork.mockResolvedValue({
      sourceSnapshot,
      targetSnapshot,
      replacement: {
        sourceSessionId: 'session-1',
        targetSessionId: 'session-2',
        targetCwd: '/workspace/fork',
        cancelled: false,
      },
    })
    render(<SessionTreePanel sessionId="session-1" onNavigateSession={onNavigateSession} />)

    fireEvent.click(await screen.findByText('user-entry'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit label' }))
    fireEvent.change(screen.getByPlaceholderText('Branch label'), { target: { value: 'checkpoint' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Branch label'), { key: 'Enter' })
    await waitFor(() => expect(mocks.setLabel).toHaveBeenCalledWith('session-1', 'user-entry', 'checkpoint'))

    fireEvent.click(screen.getByRole('button', { name: 'Fork here' }))
    await waitFor(() => expect(mocks.fork).toHaveBeenCalledWith('session-1', 'user-entry', 'at'))
    expect(mocks.applySnapshotToUi).toHaveBeenCalledWith(sourceSnapshot, { activate: false })
    expect(mocks.applySnapshotToUi).toHaveBeenCalledWith(targetSnapshot)
    expect(onNavigateSession).toHaveBeenCalledWith({ id: 'session-2', directory: '/workspace/fork' })
  })

  it('keeps the restored draft when navigation is cancelled or aborted', async () => {
    mocks.navigate
      .mockResolvedValueOnce({ snapshot: { ...snapshot(), sequence: 2 }, editorText: 'editable prompt' })
      .mockResolvedValueOnce({ snapshot: { ...snapshot(), sequence: 3 }, cancelled: true })
      .mockResolvedValueOnce({ snapshot: { ...snapshot(), sequence: 4 }, aborted: true })
    render(
      <>
        <SessionTreePanel sessionId="session-1" />
        <DraftProbe />
      </>,
    )

    fireEvent.click(await screen.findByText('user-entry'))
    fireEvent.click(screen.getByText('Return here'))
    await waitFor(() => expect(screen.getByTestId('draft')).toHaveTextContent('editable prompt'))

    fireEvent.click(screen.getByText('Return here'))
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('draft')).toHaveTextContent('editable prompt')

    fireEvent.click(screen.getByText('Return here'))
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(3))
    expect(screen.getByTestId('draft')).toHaveTextContent('editable prompt')
  })

  it('edits the current leaf label without nested interactive controls', async () => {
    mocks.setLabel.mockResolvedValue({ snapshot: { ...snapshot(), sequence: 2 } })
    render(<SessionTreePanel sessionId="session-1" />)

    fireEvent.click(await screen.findByText('working branch'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit label' }))
    const input = screen.getByPlaceholderText('Branch label')
    expect(input).toHaveValue('working branch')
    fireEvent.change(input, { target: { value: 'current checkpoint' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(mocks.setLabel).toHaveBeenCalledWith('session-1', 'assistant-entry', 'current checkpoint'),
    )
    expect(screen.getByLabelText('Session Tree')).toBeInTheDocument()
  })

  it('passes an optional cwd override when importing JSONL', async () => {
    const sourceSnapshot = snapshot()
    const targetSnapshot = snapshot('session-imported')
    mocks.importSession.mockResolvedValue({
      sourceSnapshot,
      targetSnapshot,
      replacement: {
        sourceSessionId: 'session-1',
        targetSessionId: 'session-imported',
        cancelled: false,
      },
    })
    render(<SessionTreePanel sessionId="session-1" mode="controls" />)

    fireEvent.change(screen.getByPlaceholderText('Path to a Pi JSONL file'), {
      target: { value: 'C:\\backups\\old.jsonl' },
    })
    fireEvent.change(screen.getByPlaceholderText('Working directory override (optional)'), {
      target: { value: 'C:\\work\\project' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() =>
      expect(mocks.importSession).toHaveBeenCalledWith(
        'session-1',
        'C:\\backups\\old.jsonl',
        'C:\\work\\project',
      ),
    )
  })

  it('controls native queue, retry, compaction, and tools', async () => {
    const runtimeSnapshot: SessionSnapshotV1 = {
      ...snapshot(),
      sequence: 2,
      runtime: {
        ...snapshot().runtime,
        queue: {
          steering: ['Correct the parser'],
          followUp: ['Run the tests'],
          steeringMode: 'one-at-a-time',
          followUpMode: 'all',
        },
        retry: {
          phase: 'waiting',
          autoEnabled: true,
          attempt: 2,
          maxAttempts: 3,
          delayMs: 1000,
          nextAttemptAt: '2026-01-01T00:00:01.000Z',
          errorMessage: '503 overloaded',
        },
        compaction: { autoEnabled: true, operation: { type: 'none' } },
        tools: [
          { name: 'read', description: 'Read files', parameters: {}, sourceInfo: { origin: 'builtin' } },
          { name: 'bash', description: 'Run commands', parameters: {}, sourceInfo: { origin: 'builtin' } },
        ],
        activeTools: ['read'],
      },
    }
    nativeSessionStore.replace(runtimeSnapshot)
    setPiCapabilities({
      sessionTree: true,
      sessionNavigate: true,
      queueManage: true,
      retryManage: true,
      compactionManage: true,
      toolsManage: true,
    })
    mocks.clearQueue.mockResolvedValue({ snapshot: runtimeSnapshot, cleared: { steering: [], followUp: [] } })
    mocks.abortRetry.mockResolvedValue({ snapshot: runtimeSnapshot })
    mocks.setActiveTools.mockResolvedValue({ snapshot: runtimeSnapshot })
    mocks.setQueueModes.mockResolvedValue({ snapshot: runtimeSnapshot })
    mocks.compact.mockResolvedValue({ accepted: true, snapshot: runtimeSnapshot })
    mocks.navigate.mockResolvedValue({ snapshot: runtimeSnapshot, cancelled: false })

    render(<SessionTreePanel sessionId="session-1" mode="controls" />)

    expect(screen.getByLabelText('Session Controls')).toBeInTheDocument()
    expect(mocks.fetchNativeTree).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Clear queue/ }))
    await waitFor(() => expect(mocks.clearQueue).toHaveBeenCalledWith('session-1'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled())

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(mocks.abortRetry).toHaveBeenCalledWith('session-1'))

    expect(screen.getByText('1/2 active')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('switch', { name: 'bash' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('switch', { name: 'bash' }))
    await waitFor(() => expect(mocks.setActiveTools).toHaveBeenCalledWith('session-1', ['read', 'bash']))

    fireEvent.click(screen.getAllByRole('tab', { name: 'All' })[0])
    await waitFor(() => expect(mocks.setQueueModes).toHaveBeenCalledWith('session-1', { steeringMode: 'all' }))

    fireEvent.change(screen.getByPlaceholderText('What to keep during compaction (optional)…'), {
      target: { value: 'Keep API decisions' },
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Compact now' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await waitFor(() => expect(mocks.compact).toHaveBeenCalledWith('session-1', 'Keep API decisions'))
  })

  it('keeps runtime controls out of the tree mode', async () => {
    render(<SessionTreePanel sessionId="session-1" />)

    expect(screen.getByLabelText('Session Tree')).toBeInTheDocument()
    expect(screen.queryByText('Session Controls')).not.toBeInTheDocument()
  })
})
