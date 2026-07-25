import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectDialog } from './ProjectDialog'
import { listDirectory } from '../../api'

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}))

vi.mock('../../api', () => ({
  listDirectory: vi.fn().mockResolvedValue([
    { name: '.config', type: 'directory', absolute: '/workspace/project/.config' },
    { name: 'src', type: 'directory', absolute: '/workspace/project/src' },
    { name: 'docs', type: 'directory', absolute: '/workspace/project/docs' },
  ]),
}))

describe('ProjectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initializes from the selected path and loads directory entries', async () => {
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} initialPath="/workspace/project" />)

    expect(await screen.findByDisplayValue('/workspace/project/')).toBeInTheDocument()
    expect(await screen.findByText('.config')).toBeInTheDocument()
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(await screen.findByText('docs')).toBeInTheDocument()

    expect(screen.getByText('Add current')).toBeInTheDocument()
  })

  it('does not browse a host root when no initial path is available', async () => {
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(await screen.findByPlaceholderText('Type path...')).toHaveValue('')
    expect(listDirectory).not.toHaveBeenCalled()
  })

  it('reloads the same directory when reopened', async () => {
    const props = { onClose: vi.fn(), onSelect: vi.fn(), initialPath: '/workspace/project' }
    const { rerender } = render(<ProjectDialog key="first" isOpen={true} {...props} />)

    expect(await screen.findByText('src')).toBeInTheDocument()

    rerender(<ProjectDialog key="closed" isOpen={false} {...props} />)
    rerender(<ProjectDialog key="second" isOpen={true} {...props} />)

    await waitFor(() => expect(vi.mocked(listDirectory).mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(await screen.findByText('src')).toBeInTheDocument()
  })
})
