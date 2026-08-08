import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionMenu } from './MentionMenu'
import { listDirectory, searchFiles } from '../../pi/files'

vi.mock('../../pi/files', () => ({
  listDirectory: vi.fn().mockResolvedValue([
    { name: 'src', type: 'directory' },
    { name: 'README.md', type: 'file' },
  ]),
  searchFiles: vi.fn().mockResolvedValue(['src/components/Button.tsx']),
}))

describe('MentionMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb =>
      window.setTimeout(() => cb(performance.now()), 16),
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
    vi.mocked(listDirectory).mockResolvedValue([
      { name: 'src', type: 'directory' } as never,
      { name: 'README.md', type: 'file' } as never,
    ])
    vi.mocked(searchFiles).mockResolvedValue(['src/components/Button.tsx'])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('loads root directory items when opened', async () => {
    render(
      <div>
        <MentionMenu
          isOpen={true}
          query=""
          rootPath="/workspace/project"
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      </div>,
    )

    await act(async () => {
      vi.advanceTimersByTime(32)
      await Promise.resolve()
    })

    expect(screen.getAllByText('src').length).toBeGreaterThan(0)
    expect(screen.getAllByText('README.md').length).toBeGreaterThan(0)
  })

  it('navigates back through breadcrumb control', async () => {
    const onNavigate = vi.fn()

    render(
      <div>
        <MentionMenu
          isOpen={true}
          query="src/components/"
          rootPath="/workspace/project"
          onSelect={vi.fn()}
          onNavigate={onNavigate}
          onClose={vi.fn()}
        />
      </div>,
    )

    await act(async () => {
      vi.advanceTimersByTime(32)
      await Promise.resolve()
    })

    fireEvent.click(screen.getByTitle('Go back'))
    expect(onNavigate).toHaveBeenCalledWith('src/')
  })
})
