import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgents } from './agent'
import { getConfig, getGlobalConfig, getProviderConfigs, updateConfig } from './config'
import { getHealth, disposeInstance } from './global'
import { getFormatterStatus, getLspStatus } from './lsp'
import { addMcpServer, getMcpResources, getMcpStatus } from './mcp'
import { createPtySession, getPtyConnectUrl, listAvailableShells, listPtySessions } from './pty'
import { getToolIds, getTools } from './tool'
import { createWorktree, listWorktrees } from './worktree'

const isPiServerUp = vi.hoisted(() => vi.fn())

vi.mock('../pi/sessionApi', () => ({ isPiServerUp }))

describe('unsupported Pi capability facades', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isPiServerUp.mockResolvedValue(true)
  })

  it('returns empty states for unavailable read-only capabilities', async () => {
    await expect(getAgents()).resolves.toEqual([])
    await expect(getMcpStatus()).resolves.toEqual({})
    await expect(getMcpResources()).resolves.toEqual({})
    await expect(getLspStatus()).resolves.toEqual({ running: false })
    await expect(getFormatterStatus()).resolves.toEqual({ available: false })
    await expect(listWorktrees()).resolves.toEqual([])
    await expect(listPtySessions()).resolves.toEqual([])
    await expect(listAvailableShells()).resolves.toEqual([])
    await expect(getToolIds()).resolves.toEqual([])
    await expect(getTools('provider', 'model')).resolves.toEqual([])
    await expect(getConfig()).resolves.toEqual({})
    await expect(getGlobalConfig()).resolves.toEqual({})
    await expect(getProviderConfigs()).resolves.toEqual({ providers: [] })
  })

  it('uses the Pi health endpoint', async () => {
    await expect(getHealth()).resolves.toEqual({ healthy: true })
    expect(isPiServerUp).toHaveBeenCalledOnce()
  })

  it('reports unsupported mutation and transport operations explicitly', async () => {
    await expect(addMcpServer('server', { type: 'local', command: ['cmd'] })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    })
    await expect(createWorktree({ name: 'branch' })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(createPtySession({})).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(() => getPtyConnectUrl('pty-1')).toThrow(expect.objectContaining({ code: 'NOT_SUPPORTED' }))
    await expect(updateConfig({})).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(disposeInstance('/workspace')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })
})
