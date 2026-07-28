import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderAuthDialogHost } from './ProviderAuthDialogHost'
import {
  receiveProviderAuthEvent,
  registerProviderAuthFlow,
  resetManagementEvents,
} from '../../pi/managementEventStore'

const mocks = vi.hoisted(() => ({ respond: vi.fn(), cancel: vi.fn() }))
vi.mock('../../pi/sessionApi', () => ({
  respondProviderAuth: mocks.respond,
  cancelProviderAuth: mocks.cancel,
}))

describe('ProviderAuthDialogHost', () => {
  beforeEach(() => {
    resetManagementEvents()
    mocks.respond.mockReset().mockResolvedValue(undefined)
    mocks.cancel.mockReset().mockResolvedValue(undefined)
  })

  it('renders a secret prompt and submits it to the matching global flow', async () => {
    render(<ProviderAuthDialogHost />)
    act(() => {
      registerProviderAuthFlow('flow-1', 'anthropic')
      receiveProviderAuthEvent({
        type: 'prompt',
        flowId: 'flow-1',
        promptId: 'prompt-1',
        providerId: 'anthropic',
        prompt: { type: 'secret', message: 'Enter API key', placeholder: 'key' },
      })
    })

    const input = screen.getByPlaceholderText('key')
    expect(input).toHaveAttribute('type', 'password')
    fireEvent.change(input, { target: { value: 'secret-value' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(mocks.respond).toHaveBeenCalledWith('flow-1', 'prompt-1', 'secret-value', undefined))
  })

  it('cancels a session-scoped flow when the dialog closes', async () => {
    render(<ProviderAuthDialogHost />)
    act(() => {
      registerProviderAuthFlow('flow-2', 'openai', 'session-1')
      receiveProviderAuthEvent({ type: 'notification', flowId: 'flow-2', providerId: 'openai', event: { url: 'https://example.test/login' } }, 'session-1')
    })
    expect(screen.getByRole('link', { name: 'Open authentication URL' })).toHaveAttribute('href', 'https://example.test/login')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('flow-2', 'session-1'))
  })
})
