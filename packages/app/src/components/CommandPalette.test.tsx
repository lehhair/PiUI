import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette, type CommandItem } from './CommandPalette'

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      return window.setTimeout(() => cb(performance.now()), 0)
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('resets query when reopened and executes selected command', () => {
    const onClose = vi.fn()
    const action = vi.fn()
    const commands: CommandItem[] = [{ id: 'open-settings', label: 'Open Settings', action }]

    const { rerender } = render(<CommandPalette isOpen={false} onClose={onClose} commands={commands} />)

    rerender(<CommandPalette isOpen={true} onClose={onClose} commands={commands} />)
    act(() => {
      vi.runAllTimers()
    })

    const input = screen.getByPlaceholderText('Type a command...') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'settings' } })
    expect(input.value).toBe('settings')

    fireEvent.click(screen.getByText('Open Settings'))
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => {
      vi.runAllTimers()
    })
    expect(action).toHaveBeenCalledTimes(1)

    rerender(<CommandPalette isOpen={false} onClose={onClose} commands={commands} />)
    act(() => {
      vi.runAllTimers()
    })
    expect(screen.queryByPlaceholderText('Type a command...')).not.toBeInTheDocument()

    rerender(<CommandPalette isOpen={true} onClose={onClose} commands={commands} />)
    act(() => {
      vi.runAllTimers()
    })

    expect((screen.getByPlaceholderText('Type a command...') as HTMLInputElement).value).toBe('')
  })
})
