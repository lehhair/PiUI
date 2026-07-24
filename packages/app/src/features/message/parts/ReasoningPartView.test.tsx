import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReasoningPartView } from './ReasoningPartView'
import type { ReasoningPart } from '../../../types/message'

let mockReasoningDisplayMode: 'italic' | 'markdown' | 'capsule' = 'italic'

vi.mock('../../../hooks', () => ({
  useDelayedRender: (show: boolean) => show,
  useDisclosureScrollLock: () => ({
    rootRef: () => undefined,
    headerRef: () => undefined,
    withScrollLock: (action: () => void) => action(),
  }),
}))

vi.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({ reasoningDisplayMode: mockReasoningDisplayMode }),
}))

vi.mock('../../../components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="markdown-content">{content}</div>,
}))

describe('ReasoningPartView', () => {
  beforeEach(() => {
    mockReasoningDisplayMode = 'italic'
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb =>
      window.setTimeout(() => cb(performance.now()), 16),
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('auto-expands while streaming in italic mode', () => {
    const part = {
      id: 'reason-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'reasoning',
      text: 'thinking through steps...',
      time: { start: 1 },
    } as unknown as ReasoningPart

    render(<ReasoningPartView part={part} isStreaming={true} />)

    act(() => {
      vi.advanceTimersByTime(32)
    })

    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument()
    const thinking = screen.getByText('Thinking...')
    expect(thinking).toBeInTheDocument()
    expect(thinking.className).toContain('reasoning-shimmer-text')
    expect(thinking.className).toContain('inline-block')
    expect(thinking.className).toContain('italic')
    expect(thinking.className).not.toContain('text-text-200')
    expect(screen.getAllByText('thinking through steps...').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('markdown-content')).not.toBeInTheDocument()
  })

  it('renders markdown content in markdown reasoning mode', () => {
    mockReasoningDisplayMode = 'markdown'

    const part = {
      id: 'reason-2',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'reasoning',
      text: 'Use **bold** and `code` here',
      time: { start: 1, end: 100 },
    } as unknown as ReasoningPart

    render(<ReasoningPartView part={part} isStreaming={false} />)

    expect(screen.getByTestId('markdown-content')).toHaveTextContent('Use **bold** and `code` here')
  })

  it('renders collapsed markdown preview for multiline content', () => {
    mockReasoningDisplayMode = 'markdown'

    const part = {
      id: 'reason-2b',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'reasoning',
      text: 'First line with **bold**\nSecond line with `code`',
      time: { start: 1, end: 100 },
    } as unknown as ReasoningPart

    render(<ReasoningPartView part={part} isStreaming={false} />)

    act(() => {
      vi.advanceTimersByTime(32)
    })

    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument()
    // 折叠时只渲染第一行 markdown，并走 Markdown 渲染
    expect(screen.getByTestId('markdown-content')).toHaveTextContent('First line with **bold**')
    expect(screen.getByTestId('markdown-content')).not.toHaveTextContent('Second line')
  })

  it('renders single-line content without toggle button', () => {
    const part = {
      id: 'reason-3',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'reasoning',
      text: 'short',
      time: { start: 1, end: 100 },
    } as unknown as ReasoningPart

    render(<ReasoningPartView part={part} isStreaming={false} />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getAllByText('short').length).toBeGreaterThan(0)
  })
})
