import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlashCommandMenu } from './SlashCommandMenu'

const mocks = vi.hoisted(() => ({
  loadPiSlashCommands: vi.fn(),
}))

vi.mock('../../pi/controllers/index.js', () => ({
  loadPiSlashCommands: mocks.loadPiSlashCommands,
}))

describe('SlashCommandMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb =>
      window.setTimeout(() => cb(performance.now()), 16),
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
    mocks.loadPiSlashCommands.mockResolvedValue([
      { name: 'explain', description: 'Explain code', sourceInfo: null },
      { name: 'review', description: 'Review changes', sourceInfo: null },
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('shows only frontend built-ins without a session', async () => {
    render(
      <div>
        <SlashCommandMenu isOpen={true} query="" onSelect={vi.fn()} onClose={vi.fn()} />
      </div>,
    )

    await act(async () => {
      vi.advanceTimersByTime(32)
      await Promise.resolve()
    })

    expect(mocks.loadPiSlashCommands).not.toHaveBeenCalled()
    expect(screen.getByText('/new')).toBeInTheDocument()
    expect(screen.getByText('/compact')).toBeInTheDocument()
    expect(screen.queryByText('/explain')).not.toBeInTheDocument()
  })

  it('merges native session commands and filters by query', async () => {
    render(
      <div>
        <SlashCommandMenu isOpen={true} query="exp" sessionId="session-1" onSelect={vi.fn()} onClose={vi.fn()} />
      </div>,
    )

    await act(async () => {
      vi.advanceTimersByTime(32)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.loadPiSlashCommands).toHaveBeenCalledWith('session-1')
    expect(screen.getByText('/explain')).toBeInTheDocument()
    expect(screen.queryByText('/review')).not.toBeInTheDocument()
    expect(screen.queryByText('/compact')).not.toBeInTheDocument()
  })
})
