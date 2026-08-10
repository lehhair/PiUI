import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extensionUiStore } from '../../pi/extensionUiStore'
import { ExtensionUiDialogHost } from './ExtensionUiDialogHost'

const { respondPiExtensionUi } = vi.hoisted(() => ({ respondPiExtensionUi: vi.fn() }))

vi.mock('../../pi/controllers/index.js', () => ({ respondPiExtensionUi }))
vi.mock('../../hooks', () => ({
  usePresence: () => ({ shouldRender: true, ref: () => undefined }),
}))
vi.mock('../chat/chatViewport', () => ({
  useChatViewport: () => ({ presentation: { isCompact: false } }),
}))

function selectRequest(overrides?: Partial<import('@piui/protocol').ExtensionUiDialogRequest>) {
  return {
    requestId: 'request-1',
    sessionId: 'session-1',
    kind: 'select',
    title: 'Choose mode',
    options: ['plan', 'build'],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as import('@piui/protocol').ExtensionUiDialogRequest
}

describe('ExtensionUiDialogHost', () => {
  beforeEach(() => {
    extensionUiStore.reset()
    respondPiExtensionUi.mockReset()
    respondPiExtensionUi.mockResolvedValue(undefined)
  })

  it('renders a select request and submits the chosen option', async () => {
    extensionUiStore.requestOpened(selectRequest())
    render(<ExtensionUiDialogHost sessionId="session-1" />)

    fireEvent.click(screen.getByText('build'))
    fireEvent.click(screen.getByRole('button', { name: /submit|提交/i }))

    await waitFor(() => expect(respondPiExtensionUi).toHaveBeenCalledWith(
      'session-1',
      'request-1',
      expect.objectContaining({ value: 'build', responseId: expect.any(String) }),
    ))
  })

  it('submits confirmed=true for a confirm request', async () => {
    extensionUiStore.requestOpened(selectRequest({
      requestId: 'request-confirm',
      kind: 'confirm',
      title: 'Delete file?',
      message: 'This cannot be undone',
      options: undefined,
    } as never))
    render(<ExtensionUiDialogHost sessionId="session-1" />)

    expect(screen.getByText('This cannot be undone')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /confirm|确认/i }))

    await waitFor(() => expect(respondPiExtensionUi).toHaveBeenCalledWith(
      'session-1',
      'request-confirm',
      expect.objectContaining({ confirmed: true }),
    ))
  })

  it('submits input values and keeps the title compact', async () => {
    extensionUiStore.requestOpened(selectRequest({
      requestId: 'request-input',
      kind: 'input',
      title: 'A very long extension title that should stay on one line',
      options: undefined,
      placeholder: 'Environment name',
    } as never))
    render(<ExtensionUiDialogHost sessionId="session-1" />)

    const input = screen.getByPlaceholderText('Environment name')
    fireEvent.change(input, { target: { value: 'preview-windows' } })
    fireEvent.click(screen.getByRole('button', { name: /submit|提交/i }))

    await waitFor(() => expect(respondPiExtensionUi).toHaveBeenCalledWith(
      'session-1',
      'request-input',
      expect.objectContaining({ value: 'preview-windows' }),
    ))
  })

  it('submits multi-line editor content', async () => {
    extensionUiStore.requestOpened(selectRequest({
      requestId: 'request-editor',
      kind: 'editor',
      title: 'Edit release notes',
      options: undefined,
      prefill: 'line one\nline two',
    } as never))
    render(<ExtensionUiDialogHost sessionId="session-1" />)

    const editor = screen.getByRole('textbox')
    expect(editor).toHaveValue('line one\nline two')
    fireEvent.change(editor, { target: { value: 'updated\ncontent' } })
    fireEvent.click(screen.getByRole('button', { name: /submit|提交/i }))

    await waitFor(() => expect(respondPiExtensionUi).toHaveBeenCalledWith(
      'session-1',
      'request-editor',
      expect.objectContaining({ value: 'updated\ncontent' }),
    ))
  })

  it('shows only the current session pending requests', () => {
    extensionUiStore.requestOpened(selectRequest({ sessionId: 'other-session' }))
    render(<ExtensionUiDialogHost sessionId="session-1" />)

    expect(screen.queryByText('Choose mode')).toBeNull()
  })

  it('shows queue count when multiple requests are pending', () => {
    extensionUiStore.requestOpened(selectRequest())
    extensionUiStore.requestOpened(selectRequest({
      requestId: 'request-2',
      title: 'Second question',
      createdAt: '2026-01-01T00:01:00.000Z',
    }))
    render(<ExtensionUiDialogHost sessionId="session-1" />)

    expect(screen.getByText('Choose mode')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('clears the settled request from the store after submit', async () => {
    extensionUiStore.requestOpened(selectRequest())
    render(<ExtensionUiDialogHost sessionId="session-1" />)

    fireEvent.click(screen.getByRole('button', { name: /submit|提交/i }))
    await waitFor(() => expect(respondPiExtensionUi).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('Choose mode')).toBeNull())
  })
})
