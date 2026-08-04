import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiManagementSettings } from './PiManagementSettings'

const { patchSettingsMock } = vi.hoisted(() => ({ patchSettingsMock: vi.fn() }))

const settings = {
  global: { theme: 'dark' },
  project: { defaultModel: 'project-model' },
  errors: [],
  effective: {
    defaultProvider: 'provider',
    defaultModel: 'model',
    defaultThinkingLevel: 'medium',
    transport: 'auto',
    steeringMode: 'all',
    followUpMode: 'all',
    compaction: { enabled: true },
    retry: { enabled: true },
    enableSkillCommands: true,
    showImages: true,
    shellPath: '',
    theme: 'dark',
    httpProxy: '',
    defaultProjectTrust: 'ask',
  },
}

vi.mock('../../../hooks', () => ({ useCurrentDirectory: () => '/workspace' }))
vi.mock('../../../store/messageStoreHooks', () => ({ useCurrentSessionId: () => 'session' }))
vi.mock('../../../pi/transport/index.js', () => ({
  getPiSettings: vi.fn(async () => settings),
  getProjectTrust: vi.fn(async () => ({
    trusted: false,
    decision: null,
    required: true,
    defaultDecision: 'ask',
  })),
  patchPiSettings: (...args: unknown[]) => patchSettingsMock(...args),
  setProjectTrust: vi.fn(),
}))
vi.mock('../../../pi/workspaces', () => ({
  listHostWorkspaces: vi.fn(async () => []),
  resolveWorkspacePath: vi.fn(async () => '/workspace'),
}))
vi.mock('./PiProviderManagement', () => ({ PiProviderManagement: () => null }))
vi.mock('./PiPackageManagement', () => ({ PiPackageManagement: () => null }))
vi.mock('./PiResourceManagement', () => ({ PiResourceManagement: () => null }))
vi.mock('./PiSessionManagement', () => ({ PiSessionManagement: () => null }))

describe('PiManagementSettings', () => {
  beforeEach(() => {
    patchSettingsMock.mockReset().mockResolvedValue(settings)
  })

  it('exposes common native settings and all raw settings scopes', async () => {
    render(<PiManagementSettings />)
    await screen.findByDisplayValue('dark')

    fireEvent.change(screen.getByLabelText('Pi runtime theme'), { target: { value: 'light' } })
    fireEvent.change(screen.getByLabelText('HTTP proxy'), { target: { value: 'http://127.0.0.1:7890' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSettingsMock).toHaveBeenCalledWith('/workspace', expect.objectContaining({
      theme: 'light',
      httpProxy: 'http://127.0.0.1:7890',
    })))

    fireEvent.click(screen.getByText('All effective settings and advanced patch'))
    expect(screen.getByText('Global scope')).toBeInTheDocument()
    expect(screen.getByText('Project scope')).toBeInTheDocument()
    expect(screen.getByText('Effective settings')).toBeInTheDocument()
  })
})
