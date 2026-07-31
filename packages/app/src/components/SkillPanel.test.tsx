import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillPanel } from './SkillPanel'

const getSkillsMock = vi.fn()

vi.mock('../pi/transport/index.js', () => ({
  getPiSkills: (...args: unknown[]) => getSkillsMock(...args),
}))

vi.mock('../utils', () => ({
  apiErrorHandler: vi.fn(),
}))

describe('SkillPanel', () => {
  beforeEach(() => {
    getSkillsMock.mockReset()
    getSkillsMock.mockResolvedValue([
      {
        name: 'deploy-to-vercel',
        description: 'Deploy app to Vercel',
        filePath: '/skills/deploy-to-vercel/SKILL.md',
        baseDir: '/skills/deploy-to-vercel',
        sourceInfo: { origin: 'top-level', source: 'user' },
        disableModelInvocation: false,
      },
    ])
  })

  it('renders semantic controls for refresh, search, and expandable items', async () => {
    render(<SkillPanel sessionId="session-1" />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument())
    expect(getSkillsMock).toHaveBeenCalledWith('session-1')

    const searchInput = screen.getByRole('textbox', { name: 'Filter skills...' })
    const itemButton = screen.getByRole('button', { name: /deploy-to-vercel/i })

    expect(searchInput).toHaveAttribute('name', 'skill-filter')
    expect(searchInput).toHaveAttribute('autocomplete', 'off')
    expect(itemButton).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(itemButton)

    expect(itemButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/baseDir/)).toBeInTheDocument()
  })
})
