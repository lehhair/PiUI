import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshotV1 } from '@piui/protocol'
import { SessionTreePanel } from './SessionTreePanel'
import { setPiCapabilities } from '../pi/capabilities'
import { sessionProjectionStore } from '../pi/sessionProjectionStore'
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
}))

vi.mock('../pi/applySnapshot', () => ({ applySnapshotToUi: mocks.applySnapshotToUi }))
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
}))

function snapshot(id = 'session-1'): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: `epoch-${id}`,
    sequence: 1,
    session: {
      id,
      workspaceId: 'workspace-1',
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
    timeline: [],
    native: {
      namespace: 'pi',
      schemaVersion: 1,
      leafId: 'assistant-entry',
      entries: [],
      tree: [
        {
          entry: {
            id: 'user-entry',
            parentId: null,
            timestamp: '2026-01-01T00:00:00.000Z',
            type: 'message',
            role: 'user',
            preview: 'Change the parser',
          },
          children: [
            {
              entry: {
                id: 'assistant-entry',
                parentId: 'user-entry',
                timestamp: '2026-01-01T00:00:01.000Z',
                type: 'message',
                role: 'assistant',
                preview: 'Updated the parser',
              },
              label: 'working branch',
              children: [],
            },
          ],
        },
      ],
    },
  }
}

function DraftProbe() {
  return <span data-testid="draft">{useSessionEditorDraft('session-1')?.text ?? ''}</span>
}

describe('SessionTreePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionProjectionStore.clear()
    clearSessionEditorDraft('session-1')
    sessionProjectionStore.replace(snapshot())
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

    fireEvent.click(screen.getByTitle('Return here'))

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

    fireEvent.click(screen.getAllByTitle('Edit label')[0])
    fireEvent.change(screen.getByPlaceholderText('Branch label'), { target: { value: 'checkpoint' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Branch label'), { key: 'Enter' })
    await waitFor(() => expect(mocks.setLabel).toHaveBeenCalledWith('session-1', 'user-entry', 'checkpoint'))

    fireEvent.click(screen.getAllByTitle('Fork here')[0])
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

    fireEvent.click(screen.getByTitle('Return here'))
    await waitFor(() => expect(screen.getByTestId('draft')).toHaveTextContent('editable prompt'))

    fireEvent.click(screen.getByTitle('Return here'))
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('draft')).toHaveTextContent('editable prompt')

    fireEvent.click(screen.getByTitle('Return here'))
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(3))
    expect(screen.getByTestId('draft')).toHaveTextContent('editable prompt')
  })

  it('edits the current leaf label without nested interactive controls', async () => {
    mocks.setLabel.mockResolvedValue({ snapshot: { ...snapshot(), sequence: 2 } })
    render(<SessionTreePanel sessionId="session-1" />)

    fireEvent.click(screen.getAllByTitle('Edit label')[1])
    const input = screen.getByPlaceholderText('Branch label')
    expect(input).toHaveValue('working branch')
    expect(input.closest('button')).toBeNull()
    fireEvent.change(input, { target: { value: 'current checkpoint' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(mocks.setLabel).toHaveBeenCalledWith('session-1', 'assistant-entry', 'current checkpoint'),
    )
    expect(screen.getByRole('tree')).toHaveAttribute('aria-label', 'Session Tree')
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
    render(<SessionTreePanel sessionId="session-1" />)

    fireEvent.click(screen.getByText('Import JSONL'))
    fireEvent.change(screen.getByPlaceholderText('Path to a Pi JSONL file'), {
      target: { value: 'C:\\backups\\old.jsonl' },
    })
    fireEvent.change(screen.getByPlaceholderText('Working directory override (optional)'), {
      target: { value: 'C:\\work\\project' },
    })
    fireEvent.click(screen.getByTitle('Import'))

    await waitFor(() =>
      expect(mocks.importSession).toHaveBeenCalledWith(
        'session-1',
        'C:\\backups\\old.jsonl',
        'C:\\work\\project',
      ),
    )
  })

  it('controls native queue, retry, compaction, tools, and branch summaries', async () => {
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
          { name: 'read', description: 'Read files', source: 'builtin' },
          { name: 'bash', description: 'Run commands', source: 'builtin' },
        ],
        activeTools: ['read'],
      },
    }
    sessionProjectionStore.replace(runtimeSnapshot)
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
    mocks.compact.mockResolvedValue({ accepted: true, snapshot: runtimeSnapshot })
    mocks.navigate.mockResolvedValue({ snapshot: runtimeSnapshot, cancelled: false })

    render(<SessionTreePanel sessionId="session-1" />)

    expect(screen.getByText('Correct the parser')).toBeInTheDocument()
    expect(screen.getByText('Run the tests')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Clear queued messages'))
    await waitFor(() => expect(mocks.clearQueue).toHaveBeenCalledWith('session-1'))

    fireEvent.click(screen.getByText('Stop retry 2/3'))
    await waitFor(() => expect(mocks.abortRetry).toHaveBeenCalledWith('session-1'))

    fireEvent.click(screen.getByText('Tools (1/2 active)'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'bash' }))
    await waitFor(() => expect(mocks.setActiveTools).toHaveBeenCalledWith('session-1', ['read', 'bash']))

    fireEvent.change(screen.getByPlaceholderText('Compaction instructions (optional)'), {
      target: { value: 'Keep API decisions' },
    })
    fireEvent.click(screen.getByTitle('Compact context'))
    await waitFor(() => expect(mocks.compact).toHaveBeenCalledWith('session-1', 'Keep API decisions'))

    fireEvent.click(screen.getByLabelText('Summarize the abandoned branch when navigating'))
    fireEvent.click(screen.getByTitle('Return here'))
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('session-1', 'user-entry', true))
  })
})
