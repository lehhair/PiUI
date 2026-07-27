import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extensionUiStore } from '../../pi/extensionUiStore'
import { ExtensionUiDialogHost } from './ExtensionUiDialogHost'

const { respondExtensionUi } = vi.hoisted(() => ({ respondExtensionUi: vi.fn() }))

vi.mock('../../pi/sessionApi', () => ({ respondExtensionUi }))
vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ isOpen, title, children }: { isOpen: boolean; title: React.ReactNode; children: React.ReactNode }) =>
    isOpen ? <div role="dialog" aria-label={String(title)}>{children}</div> : null,
}))
vi.mock('../../components/ui/Button', () => ({
  Button: ({ children, isLoading: _isLoading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) =>
    <button {...props}>{children}</button>,
}))

describe('ExtensionUiDialogHost', () => {
  beforeEach(() => {
    extensionUiStore.reset()
    respondExtensionUi.mockReset()
    respondExtensionUi.mockResolvedValue({ accepted: true, alreadySettled: false })
  })

  it('renders and submits a pending select request', async () => {
    extensionUiStore.requestOpened({
      requestId: 'request-1',
      sessionId: 'session-1',
      workerGeneration: 'generation-1',
      kind: 'select',
      title: 'Choose mode',
      options: ['plan', 'build'],
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    render(<ExtensionUiDialogHost />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'build' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(respondExtensionUi).toHaveBeenCalledWith(
      'session-1',
      'request-1',
      expect.objectContaining({ value: 'build', responseId: expect.any(String) }),
      'generation-1',
    ))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
