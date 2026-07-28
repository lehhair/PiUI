import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiProviderManagement } from './PiProviderManagement'

const { refreshModelsMock, refreshRuntimeMock, reloadRuntimeMock } = vi.hoisted(() => ({
  refreshModelsMock: vi.fn(),
  refreshRuntimeMock: vi.fn(),
  reloadRuntimeMock: vi.fn(),
}))

vi.mock('../../../hooks/useModels', () => ({ refreshModels: () => refreshModelsMock() }))
vi.mock('../../../pi/managementEventStore', () => ({
  registerProviderAuthFlow: vi.fn(),
  trackManagementProviders: vi.fn(),
  useManagementEvents: () => ({ providerRevision: 0 }),
}))
vi.mock('../../../pi/sessionApi', () => ({
  inspectModelRuntime: vi.fn(async () => ({
    providers: [],
    availableModels: [],
    registeredProviderIds: [],
  })),
  listPiProviders: vi.fn(async () => []),
  listSessionProviders: vi.fn(async () => []),
  logoutProvider: vi.fn(),
  logoutSessionProvider: vi.fn(),
  refreshModelRuntime: (...args: unknown[]) => refreshRuntimeMock(...args),
  reloadModelRuntime: (...args: unknown[]) => reloadRuntimeMock(...args),
  removeProviderApiKey: vi.fn(),
  setProviderApiKey: vi.fn(),
  setSessionProviderApiKey: vi.fn(),
  startProviderAuth: vi.fn(),
}))

describe('PiProviderManagement', () => {
  beforeEach(() => {
    refreshModelsMock.mockReset().mockResolvedValue(undefined)
    refreshRuntimeMock.mockReset().mockResolvedValue(undefined)
    reloadRuntimeMock.mockReset().mockResolvedValue(undefined)
  })

  it('refreshes the chat model catalog after native runtime changes', async () => {
    render(<PiProviderManagement sessionId="session" />)
    await screen.findByText('0 providers · 0 available models · 0 registered')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(refreshModelsMock).toHaveBeenCalledTimes(1))
    expect(refreshRuntimeMock).toHaveBeenCalledWith(undefined)

    const reload = screen.getByRole('button', { name: 'Reload' })
    await waitFor(() => expect(reload).not.toBeDisabled())
    fireEvent.click(reload)
    await waitFor(() => expect(refreshModelsMock).toHaveBeenCalledTimes(2))
    expect(reloadRuntimeMock).toHaveBeenCalledWith(undefined)
  })
})
