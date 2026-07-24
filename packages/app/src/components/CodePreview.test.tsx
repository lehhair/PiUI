import { act, fireEvent, render, screen } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { CodePreview } from './CodePreview'

vi.mock('../store/themeStore', () => ({
  themeStore: {
    subscribe: () => () => {},
    getSnapshot: () => mockThemeSnapshot,
  },
}))

vi.mock('../hooks/useSyntaxHighlight', () => ({
  useSyntaxHighlightRef: () => ({
    tokensRef: { current: null },
    version: 0,
  }),
}))

const mockThemeSnapshot = {
  codeWordWrap: false,
  codeFontScale: 0,
}

describe('CodePreview', () => {
  it('renders code through CodeMirror with line numbers', () => {
    const { container } = render(<CodePreview code={'first line\nsecond line'} language="text" />)

    expect(screen.getByText('first line')).toBeInTheDocument()
    expect(screen.getByText('second line')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(container.querySelector('.cm-editor')).toBeInTheDocument()
  })

  it('keeps the editor focusable while read-only', () => {
    const { container } = render(
      <CodePreview code={'const someRidiculouslyLongIdentifierName = "value"\nsecond line'} language="text" />,
    )

    expect(container.querySelector('.cm-content')).toHaveAttribute('contenteditable', 'true')
  })

  it('disables editable focus for constrained inline previews', () => {
    const { container } = render(<CodePreview code={'first line\nsecond line'} language="text" maxHeight={120} />)

    expect(container.querySelector('.cm-content')).toHaveAttribute('contenteditable', 'false')
  })

  it('opens CodeMirror search from the preview Ctrl+F fallback', () => {
    const { container } = render(<CodePreview code={'first line\nsecond line'} language="text" />)

    fireEvent.keyDown(container.firstElementChild as Element, { key: 'f', ctrlKey: true })

    expect(screen.getByPlaceholderText('Find')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Match case' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use regular expression' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Match whole word' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument()
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('requests a CodeMirror measure when becoming visible again', async () => {
    vi.useFakeTimers()
    const requestMeasureSpy = vi.spyOn(EditorView.prototype, 'requestMeasure')

    try {
      const { rerender } = render(<CodePreview code={'first line\nsecond line'} language="text" isVisible={false} />)

      await act(async () => {
        await Promise.resolve()
      })
      requestMeasureSpy.mockClear()

      rerender(<CodePreview code={'first line\nsecond line'} language="text" isVisible />)

      await act(async () => {
        vi.advanceTimersByTime(16)
        await Promise.resolve()
      })

      expect(requestMeasureSpy).toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(320)
        await Promise.resolve()
      })

      expect(requestMeasureSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      requestMeasureSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('requests a CodeMirror measure when an ancestor layout transition settles', async () => {
    vi.useFakeTimers()
    const requestMeasureSpy = vi.spyOn(EditorView.prototype, 'requestMeasure')

    try {
      const { rerender } = render(
        <CodePreview code={'first line\nsecond line'} language="text" isVisible layoutVersion={0} />,
      )

      await act(async () => {
        vi.advanceTimersByTime(320)
        await Promise.resolve()
      })
      requestMeasureSpy.mockClear()

      rerender(<CodePreview code={'first line\nsecond line'} language="text" isVisible layoutVersion={1} />)

      await act(async () => {
        vi.advanceTimersByTime(16)
        await Promise.resolve()
      })

      expect(requestMeasureSpy).toHaveBeenCalled()
    } finally {
      requestMeasureSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
