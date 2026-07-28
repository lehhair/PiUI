import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCommands } from './command'

const listMock = vi.fn()
const isPiServerUpMock = vi.fn()

vi.mock('../pi/sessionApi', () => ({
  isPiServerUp: () => isPiServerUpMock(),
  listSessionCommands: (...args: unknown[]) => listMock(...args),
}))

vi.mock('../pi/nativeSessionStore', () => ({
  nativeSessionStore: { getActiveSessionId: () => 'pi-session' },
}))

describe('getCommands', () => {
  beforeEach(() => {
    listMock.mockReset()
    isPiServerUpMock.mockResolvedValue(true)
  })

  it('marks frontend and api commands with stable sources', async () => {
    listMock.mockResolvedValue({ commands: [{ name: 'review', description: 'Run project review' }] })

    const commands = await getCommands('/workspace/project')

    expect(commands).toEqual([
      { name: 'review', description: 'Run project review', source: 'api' },
      { name: 'new', description: 'Create a new chat session', source: 'frontend' },
      { name: 'compact', description: 'Compact session by summarizing conversation history', source: 'frontend' },
    ])
  })

  it('keeps API commands as api commands even if names overlap frontend commands', async () => {
    listMock.mockResolvedValue({ commands: [{ name: 'compact', description: 'Native compact command' }] })

    const commands = await getCommands('/workspace/project-overlap')

    expect(commands).toEqual([
      { name: 'compact', description: 'Native compact command', source: 'api' },
      { name: 'new', description: 'Create a new chat session', source: 'frontend' },
    ])
  })
})
