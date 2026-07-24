import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlashCommandMenu } from './SlashCommandMenu'

vi.mock('../../api/command', () => ({
  getCommands: vi.fn().mockResolvedValue([
    { name: 'compact', description: 'Compact session', source: 'frontend' },
    { name: 'explain', description: 'Explain code', source: 'api' },
  ]),
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
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('loads and filters commands based on query', async () => {
    render(
      <div>
        <SlashCommandMenu
          isOpen={true}
          query="comp"
          onSelect={vi.fn()}
          onClose={vi.fn()}
          rootPath="/workspace/project"
        />
      </div>,
    )

    await act(async () => {
      vi.advanceTimersByTime(32)
      await Promise.resolve()
    })

    expect(screen.getByText('/compact')).toBeInTheDocument()
    expect(screen.queryByText('/explain')).not.toBeInTheDocument()
  })
})
