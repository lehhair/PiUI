import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlashCommandMenu } from './SlashCommandMenu'
import { getFrontendCommands } from './builtinCommands'

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

  it('shows the full Pi TUI builtin command list without a session', async () => {
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
    expect(screen.getByText('/model')).toBeInTheDocument()
    expect(screen.getByText('/settings')).toBeInTheDocument()
    expect(screen.getByText('/export')).toBeInTheDocument()
    expect(screen.getByText('/share')).toBeInTheDocument()
    expect(screen.getByText('/bash')).toBeInTheDocument()
    expect(screen.queryByText('/explain')).not.toBeInTheDocument()
  })

  it('keeps builtin commands even when the session registry has no commands', async () => {
    mocks.loadPiSlashCommands.mockResolvedValue([])

    render(
      <div>
        <SlashCommandMenu isOpen={true} query="" sessionId="session-1" onSelect={vi.fn()} onClose={vi.fn()} />
      </div>,
    )

    await act(async () => {
      vi.advanceTimersByTime(32)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.loadPiSlashCommands).toHaveBeenCalledWith('session-1')
    expect(screen.getByText('/new')).toBeInTheDocument()
    expect(screen.getByText('/compact')).toBeInTheDocument()
    expect(screen.getByText('/model')).toBeInTheDocument()
  })

  it('merges native extension commands with builtins and filters by query', async () => {
    render(
      <div>
        <SlashCommandMenu isOpen={true} query="expl" sessionId="session-1" onSelect={vi.fn()} onClose={vi.fn()} />
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
    expect(screen.queryByText('/export')).not.toBeInTheDocument()
  })

  it('does not duplicate builtin commands reported by the registry', async () => {
    mocks.loadPiSlashCommands.mockResolvedValue([
      { name: 'new', description: 'registry new', sourceInfo: { builtin: true } },
      { name: 'explain', description: 'Explain code', sourceInfo: null },
    ])

    render(
      <div>
        <SlashCommandMenu isOpen={true} query="" sessionId="session-1" onSelect={vi.fn()} onClose={vi.fn()} />
      </div>,
    )

    await act(async () => {
      vi.advanceTimersByTime(32)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getAllByText('/new')).toHaveLength(1)
    expect(screen.getByText('/explain')).toBeInTheDocument()
  })

  it('exports the pi TUI builtin command set', () => {
    const names = getFrontendCommands().map(cmd => cmd.name)
    for (const builtin of [
      'new', 'compact', 'model', 'settings', 'hotkeys', 'changelog', 'resume',
      'session', 'tree', 'clone', 'copy', 'fork', 'trust', 'login', 'logout',
      'export', 'import', 'scoped-models', 'name', 'share', 'reload', 'quit', 'bash',
    ]) {
      expect(names).toContain(builtin)
    }
  })

  it('filters by command name only, not description', async () => {
    render(
      <div>
        <SlashCommandMenu isOpen={true} query="session" onSelect={vi.fn()} onClose={vi.fn()} />
      </div>,
    )

    await act(async () => {
      vi.advanceTimersByTime(32)
      await Promise.resolve()
    })

    // /session 名字精确匹配
    expect(screen.getByText('/session')).toBeInTheDocument()
    // 描述里含 "session" 的 /resume /new /export /import 不应出现
    expect(screen.queryByText('/resume')).not.toBeInTheDocument()
    expect(screen.queryByText('/new')).not.toBeInTheDocument()
    expect(screen.queryByText('/export')).not.toBeInTheDocument()
    expect(screen.queryByText('/import')).not.toBeInTheDocument()
  })
})
