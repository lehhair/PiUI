import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderAuthDialogHost } from './ProviderAuthDialogHost'
import {
  receiveProviderAuthEvent,
  registerProviderAuthFlow,
  resetManagementEvents,
} from '../../pi/managementEventStore'

const mocks = vi.hoisted(() => ({ respond: vi.fn(), cancel: vi.fn(), listFlows: vi.fn() }))
vi.mock('../../pi/transport/index.js', () => ({
  respondProviderAuth: mocks.respond,
  cancelProviderAuth: mocks.cancel,
  listActiveProviderFlows: mocks.listFlows,
}))

describe('ProviderAuthDialogHost', () => {
  beforeEach(() => {
    resetManagementEvents()
    mocks.respond.mockReset().mockResolvedValue(undefined)
    mocks.cancel.mockReset().mockResolvedValue(undefined)
    mocks.listFlows.mockReset().mockResolvedValue([])
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
    await waitFor(() => expect(mocks.respond).toHaveBeenCalledWith('flow-1', 'prompt-1', 'secret-value'))
  })

  it('cancels the flow when the dialog closes', async () => {
    render(<ProviderAuthDialogHost />)
    act(() => {
      registerProviderAuthFlow('flow-2', 'openai', 'session-1')
      receiveProviderAuthEvent({ type: 'notification', flowId: 'flow-2', providerId: 'openai', event: { url: 'https://example.test/login' } }, 'session-1')
    })
    expect(screen.getByRole('link', { name: 'Open authentication URL' })).toHaveAttribute('href', 'https://example.test/login')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('flow-2'))
  })

  it('restores an in-flight flow from the worker snapshot after a refresh', async () => {
    mocks.listFlows.mockResolvedValue([{
      flowId: 'flow-3',
      providerId: 'anthropic',
      authType: 'api_key',
      prompts: [{ promptId: 'prompt-3', type: 'secret', message: 'Enter API key', placeholder: 'key' }],
    }])
    render(<ProviderAuthDialogHost />)

    const input = await screen.findByPlaceholderText('key')
    expect(input).toHaveAttribute('type', 'password')
    fireEvent.change(input, { target: { value: 'recovered' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(mocks.respond).toHaveBeenCalledWith('flow-3', 'prompt-3', 'recovered'))
  })
})
