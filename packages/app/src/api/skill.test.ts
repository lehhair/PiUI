import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSkills } from './skill'

const listSessionSkills = vi.hoisted(() => vi.fn())

vi.mock('../pi/sessionApi', () => ({ listSessionSkills }))

describe('Pi skill facade', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not query skills without an active session', async () => {
    await expect(getSkills(null)).resolves.toEqual([])
    expect(listSessionSkills).not.toHaveBeenCalled()
  })

  it('maps skills from the active Pi session', async () => {
    listSessionSkills.mockResolvedValue({
      skills: [{
        name: 'review',
        description: 'Review code',
        filePath: '/skills/review/SKILL.md',
        baseDir: '/skills/review',
        sourceInfo: { origin: 'top-level' },
        disableModelInvocation: false,
      }],
    })

    await expect(getSkills('session-1')).resolves.toEqual([
      { name: 'review', description: 'Review code', location: '/skills/review/SKILL.md' },
    ])
    expect(listSessionSkills).toHaveBeenCalledWith('session-1')
  })
})
