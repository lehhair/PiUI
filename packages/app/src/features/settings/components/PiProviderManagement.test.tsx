import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiProviderManagement } from './PiProviderManagement'

const { loadPiModelsMock, refreshRuntimeMock, reloadRuntimeMock } = vi.hoisted(() => ({
  loadPiModelsMock: vi.fn(),
  refreshRuntimeMock: vi.fn(),
  reloadRuntimeMock: vi.fn(),
}))

vi.mock('../../../pi/controllers/index.js', () => ({ loadPiModels: () => loadPiModelsMock() }))
vi.mock('../../../pi/managementEventStore', () => ({
  registerProviderAuthFlow: vi.fn(),
  trackManagementProviders: vi.fn(),
  useManagementEvents: () => ({ providerRevision: 0 }),
}))
vi.mock('../../../pi/transport/index.js', () => ({
  inspectModelRuntime: vi.fn(async () => ({
    providers: [],
    availableModels: [],
    registeredProviderIds: [],
  })),
  listPiProviders: vi.fn(async () => []),
  logoutProvider: vi.fn(),
  refreshModelRuntime: (...args: unknown[]) => refreshRuntimeMock(...args),
  reloadModelRuntime: (...args: unknown[]) => reloadRuntimeMock(...args),
  removeProviderApiKey: vi.fn(),
  setProviderApiKey: vi.fn(),
  startProviderAuth: vi.fn(),
}))

describe('PiProviderManagement', () => {
  beforeEach(() => {
    loadPiModelsMock.mockReset().mockResolvedValue([])
    refreshRuntimeMock.mockReset().mockResolvedValue(undefined)
    reloadRuntimeMock.mockReset().mockResolvedValue(undefined)
  })

  it('refreshes the chat model catalog after native runtime changes', async () => {
    render(<PiProviderManagement />)
    await screen.findByText('0 providers · 0 available models · 0 registered')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(loadPiModelsMock).toHaveBeenCalledTimes(1))
    expect(refreshRuntimeMock).toHaveBeenCalledTimes(1)

    const reload = screen.getByRole('button', { name: 'Reload' })
    await waitFor(() => expect(reload).not.toBeDisabled())
    fireEvent.click(reload)
    await waitFor(() => expect(loadPiModelsMock).toHaveBeenCalledTimes(2))
    expect(reloadRuntimeMock).toHaveBeenCalledTimes(1)
  })
})
