// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectTrustPrompt } from './ProjectTrustPrompt'
import type { PiProjectTrust } from '../../pi/domain'

const { getProjectTrustMock, setProjectTrustMock } = vi.hoisted(() => ({
  getProjectTrustMock: vi.fn(),
  setProjectTrustMock: vi.fn(),
}))

vi.mock('../../pi/transport/index.js', () => ({
  getProjectTrust: (...args: unknown[]) => getProjectTrustMock(...args),
  setProjectTrust: (...args: unknown[]) => setProjectTrustMock(...args),
}))

function trust(overrides: Partial<PiProjectTrust> = {}): PiProjectTrust {
  return {
    workspacePath: '/workspace/app',
    required: false,
    decision: null,
    defaultDecision: 'ask',
    trusted: true,
    ...overrides,
  }
}

describe('ProjectTrustPrompt', () => {
  beforeEach(() => {
    getProjectTrustMock.mockReset()
    setProjectTrustMock.mockReset()
    setProjectTrustMock.mockResolvedValue(trust({ decision: true, trusted: true }))
  })

  it('does not prompt when the workspace does not require trust', async () => {
    getProjectTrustMock.mockResolvedValue(trust())
    render(<ProjectTrustPrompt cwd="/workspace/app" />)
    await waitFor(() => expect(getProjectTrustMock).toHaveBeenCalledWith('/workspace/app'))
    expect(screen.queryByText('Trust this project?')).not.toBeInTheDocument()
  })

  it('does not prompt again when a trust decision is already saved', async () => {
    getProjectTrustMock.mockResolvedValue(trust({ required: true, decision: true, trusted: true }))
    render(<ProjectTrustPrompt cwd="/workspace/app" />)
    await waitFor(() => expect(getProjectTrustMock).toHaveBeenCalledWith('/workspace/app'))
    expect(screen.queryByText('Trust this project?')).not.toBeInTheDocument()
  })

  it('prompts and persists the decision when trust is required and undecided', async () => {
    getProjectTrustMock.mockResolvedValue(trust({ required: true, decision: null, trusted: false }))
    render(<ProjectTrustPrompt cwd="/workspace/app" />)

    expect(await screen.findByText('Trust this project?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Trust' }))
    await waitFor(() => expect(setProjectTrustMock).toHaveBeenCalledWith('/workspace/app', true))
    await waitFor(() => expect(screen.queryByText('Trust this project?')).not.toBeInTheDocument())
  })

  it('persists a denial when the user rejects the project', async () => {
    getProjectTrustMock.mockResolvedValue(trust({ required: true, decision: null, trusted: false }))
    render(<ProjectTrustPrompt cwd="/workspace/app" />)

    expect(await screen.findByText('Trust this project?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(setProjectTrustMock).toHaveBeenCalledWith('/workspace/app', false))
  })

  it('dismisses without saving when choosing later', async () => {
    getProjectTrustMock.mockResolvedValue(trust({ required: true, decision: null, trusted: false }))
    render(<ProjectTrustPrompt cwd="/workspace/app" />)

    expect(await screen.findByText('Trust this project?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(setProjectTrustMock).toHaveBeenCalledWith('/workspace/app', null))
  })

  it('clears the prompt when the workspace changes to one that is trusted', async () => {
    getProjectTrustMock
      .mockResolvedValueOnce(trust({ required: true, decision: null, trusted: false }))
      .mockResolvedValueOnce(trust())
    const { rerender } = render(<ProjectTrustPrompt cwd="/workspace/app" />)
    expect(await screen.findByText('Trust this project?')).toBeInTheDocument()

    await act(async () => {
      rerender(<ProjectTrustPrompt cwd="/workspace/trusted" />)
    })
    await waitFor(() => expect(screen.queryByText('Trust this project?')).not.toBeInTheDocument())
  })
})
