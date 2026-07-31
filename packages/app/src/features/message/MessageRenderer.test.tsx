import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MessageRenderer,
  assistantHasFinalContent,
  assistantHasProcessContent,
  splitProcessRenderItems,
} from './MessageRenderer'
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent'
import type { PiAssistantMessageItem, PiUserMessageItem } from '../../pi/domain/index.js'

let mockRenderUserMarkdown = false
let mockCollapseUserMessages = false

vi.mock('motion/mini', () => ({
  animate: () => Promise.resolve(),
}))

vi.mock('../../hooks', () => ({
  useDelayedRender: (show: boolean) => show,
  useDisclosureScrollLock: () => ({
    rootRef: () => undefined,
    headerRef: () => undefined,
    withScrollLock: (action: () => void) => action(),
  }),
}))

vi.mock('../../hooks/useInputCapabilities', () => ({
  useInputCapabilities: () => ({ preferTouchUi: false, canHover: true, hasCoarsePointer: false, hasTouch: false }),
}))

vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    collapseUserMessages: mockCollapseUserMessages,
    renderUserMarkdown: mockRenderUserMarkdown,
    stepFinishDisplay: { latestOnly: true, turnDuration: false, tokens: true, cache: true, cost: true, duration: true, agent: false, model: false, completedAt: false },
    actionsOnLatestAssistantOnly: true,
    descriptiveToolSteps: false,
    inlineToolRequests: false,
    immersiveMode: false,
  }),
}))

vi.mock('../../components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="user-markdown">{content}</div>,
}))

vi.mock('../../components/ui', () => ({
  CopyButton: ({ text }: { text: string }) => <button type="button">copy:{text}</button>,
  SmoothHeight: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('./parts', () => ({
  TextPartView: ({ part }: { part: { text: string } }) => <div>{part.text}</div>,
  ReasoningPartView: () => null,
  ToolPartView: () => null,
  MessageErrorView: () => null,
}))

function rawEntry(id: string): SessionMessageEntry {
  return { type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: '', timestamp: 1 } }
}

function createAssistantItem(text: string): PiAssistantMessageItem {
  return {
    kind: 'assistant_message',
    entryId: 'assistant-1',
    timestamp: 1,
    rawEntry: rawEntry('assistant-1'),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'model-1',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 1,
    },
    blocks: [{ type: 'text', text }],
    toolResults: {},
  }
}

function createUserTextItem(text: string): PiUserMessageItem {
  return {
    kind: 'user_message',
    entryId: 'user-1',
    timestamp: 1,
    rawEntry: rawEntry('user-1'),
    message: { role: 'user', content: text, timestamp: 1 },
    blocks: [{ type: 'text', text }],
  }
}

describe('MessageRenderer assistant fork', () => {
  beforeEach(() => {
    mockRenderUserMarkdown = false
    mockCollapseUserMessages = false
  })

  it('does not offer fork on assistant messages (pi parity: fork is user-message only)', async () => {
    const onFork = vi.fn()
    const item = createAssistantItem('assistant reply')

    render(<MessageRenderer item={item} onFork={onFork} forkMessageId="assistant-2" />)

    expect(screen.queryByRole('button', { name: /fork|分叉/i })).toBeNull()
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy()
  })

  it('hides fork when the assistant message has no copyable text', () => {
    const onFork = vi.fn()
    const item = createAssistantItem('   ')

    render(<MessageRenderer item={item} onFork={onFork} forkMessageId="assistant-2" />)

    expect(screen.queryByRole('button', { name: /fork|分叉/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
  })

  it('keeps user text plain by default', () => {
    render(<MessageRenderer item={createUserTextItem('Use **bold** text')} />)

    expect(screen.queryByTestId('user-markdown')).toBeNull()
    expect(screen.getByText('Use **bold** text')).toBeInTheDocument()
  })

  it('renders user text through markdown when enabled', () => {
    mockRenderUserMarkdown = true

    render(<MessageRenderer item={createUserTextItem('Use **bold** text')} />)

    expect(screen.getByTestId('user-markdown')).toHaveTextContent('Use **bold** text')
  })

  it('does not crop an interactive user HTML artifact to the collapsed preview height', () => {
    mockRenderUserMarkdown = true
    mockCollapseUserMessages = true
    const item = createUserTextItem(
      '<section><style>section{height:380px}</style><canvas></canvas><script>requestAnimationFrame(()=>{})</script></section>',
    )

    render(<MessageRenderer item={item} />)

    const container = screen.getByTestId('user-markdown').parentElement!
    expect(container.style.maxHeight).toBe('')
    expect(container.style.contain).toBe('')
    expect(screen.getByTestId('user-markdown').closest('.bg-bg-300')).toHaveClass('w-full', 'max-w-2xl')
    expect(screen.getByTestId('user-markdown').closest('.group')).toHaveClass('w-full')
    expect(screen.getByTestId('user-markdown').closest('[data-user-html-artifact]')).toBeInTheDocument()
  })

  it('clamps a collapsible non-artifact user message with layout isolation', () => {
    mockRenderUserMarkdown = true
    mockCollapseUserMessages = true
    render(<MessageRenderer item={createUserTextItem('just some plain text')} />)

    const container = screen.getByTestId('user-markdown').parentElement!
    expect(container.style.maxHeight).not.toBe('')
    expect(container.style.contain).toBe('layout paint')
  })
})

describe('process content split', () => {
  function createCompletedAssistantItem(blocks: PiAssistantMessageItem['blocks']): PiAssistantMessageItem {
    return {
      kind: 'assistant_message',
      entryId: 'assistant-1',
      timestamp: 1,
      rawEntry: rawEntry('assistant-1'),
      message: {
        role: 'assistant',
        content: blocks,
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'model-1',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: 2,
      },
      blocks,
      toolResults: {},
    }
  }

  it('keeps streaming assistant as process-only until completed', () => {
    const item = createCompletedAssistantItem([{ type: 'text', text: 'partial' }])

    expect(assistantHasProcessContent({ ...item, isStreaming: true })).toBe(true)
    expect(assistantHasFinalContent({ ...item, isStreaming: true })).toBe(false)
  })

  it('splits completed tool+text into process and final', () => {
    const item = createCompletedAssistantItem([
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
      { type: 'text', text: 'done' },
    ])

    expect(assistantHasProcessContent(item)).toBe(true)
    expect(assistantHasFinalContent(item)).toBe(true)

    // pure text has final only
    const plain = createCompletedAssistantItem([{ type: 'text', text: 'hello' }])
    expect(assistantHasProcessContent(plain)).toBe(false)
    expect(assistantHasFinalContent(plain)).toBe(true)
    void splitProcessRenderItems
  })
})
