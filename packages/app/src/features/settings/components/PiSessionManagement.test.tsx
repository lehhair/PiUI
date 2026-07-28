import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiSessionManagement } from './PiSessionManagement'

const { executeBashMock, promptMock } = vi.hoisted(() => ({
  executeBashMock: vi.fn(),
  promptMock: vi.fn(),
}))

vi.mock('../../../pi/applySnapshot', () => ({ applySnapshotToUi: vi.fn() }))
vi.mock('../../../pi/sessionApi', () => ({
  abortPiBash: vi.fn(),
  appendPiCustomEntry: vi.fn(),
  createNativePiSession: vi.fn(),
  cyclePiSessionModel: vi.fn(),
  cyclePiThinkingLevel: vi.fn(),
  executePiBash: (...args: unknown[]) => executeBashMock(...args),
  exportPiSession: vi.fn(),
  fetchSnapshot: vi.fn(async () => ({
    session: { id: 'session', state: 'idle', directory: '/workspace' },
    runtime: { thinkingLevel: 'medium', scopedModels: [] },
  })),
  listPiSessions: vi.fn(async () => []),
  listPiSessionModels: vi.fn(async () => []),
  promptSession: (...args: unknown[]) => promptMock(...args),
  sendPiCustomMessage: vi.fn(),
  sendPiUserMessage: vi.fn(),
  setPiScopedModels: vi.fn(),
  switchNativePiSession: vi.fn(),
  waitForPiSessionIdle: vi.fn(),
}))

describe('PiSessionManagement', () => {
  beforeEach(() => {
    executeBashMock.mockReset().mockResolvedValue({ result: 'ok' })
    promptMock.mockReset().mockResolvedValue({ accepted: true })
  })

  it('passes prompt-template and bash-context controls to the native APIs', async () => {
    render(<PiSessionManagement sessionId="session" workspacePath="/workspace" />)
    await screen.findByText('Session commands')

    fireEvent.change(screen.getByPlaceholderText('Prompt through AgentSession.prompt'), {
      target: { value: '/review changes' },
    })
    fireEvent.click(screen.getByLabelText('Expand prompt templates'))
    fireEvent.click(screen.getByRole('button', { name: 'Prompt' }))
    await waitFor(() => expect(promptMock).toHaveBeenCalledWith('session', '/review changes', {
      stream: true,
      expandPromptTemplates: false,
    }))

    fireEvent.change(screen.getByPlaceholderText('One-shot bash command'), {
      target: { value: 'git status' },
    })
    fireEvent.click(screen.getByLabelText('Exclude bash output from session context'))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(executeBashMock).toHaveBeenCalledWith('session', 'git status', true))
  })
})
