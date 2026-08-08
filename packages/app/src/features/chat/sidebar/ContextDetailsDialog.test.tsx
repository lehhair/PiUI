// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ContextDetailsDialog } from './ContextDetailsDialog'

class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const { useSessionStatsMock } = vi.hoisted(() => ({ useSessionStatsMock: vi.fn() }))

vi.mock('../../../hooks', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks')>('../../../hooks')
  return {
    ...actual,
    useSessionStats: () => useSessionStatsMock(),
  }
})

vi.mock('../../../pi/hooks/index.js', () => ({
  useFocusedSessionId: () => 'session-1',
  usePiBranchData: () => ({
    items: [
      {
        id: 'entry-user-1',
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          timestamp: 1_700_000_000_000,
        },
      },
      {
        id: 'entry-assistant-1',
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'hi' }],
          usage: {
            input: 12_000,
            output: 800,
            cacheRead: 100,
            cacheWrite: 50,
            cost: { total: 0.42 },
          },
          timestamp: 1_700_000_001_000,
        },
      },
    ],
  }),
}))

function renderDialog() {
  return render(
    <ContextDetailsDialog isOpen onClose={vi.fn()} contextLimit={200_000} />,
  )
}

describe('ContextDetailsDialog', () => {
  it('shows native session stats and context usage', () => {
    useSessionStatsMock.mockReturnValue({
      inputTokens: 12_000,
      outputTokens: 800,
      reasoningTokens: 0,
      cacheRead: 100,
      cacheWrite: 50,
      totalTokens: 12_950,
      totalCost: 0.42,
      contextUsed: 64_000,
      contextLimit: 200_000,
      contextPercent: 32,
      contextEstimated: false,
    })

    renderDialog()

    // 会话摘要
    expect(screen.getByText('session-1')).toBeInTheDocument()
    expect(screen.getByText('contextDetails.messages')).toBeInTheDocument()
    // provider / model 来自最近一条带 usage 的 assistant 消息
    expect(screen.getByText('anthropic')).toBeInTheDocument()
    expect(screen.getByText('claude-sonnet-4')).toBeInTheDocument()
    // context 用量与费用
    expect(screen.getByText('200.0k')).toBeInTheDocument()
    expect(screen.getByText('64.0k')).toBeInTheDocument()
    expect(screen.getByText('32%')).toBeInTheDocument()
    // 总费用 + assistant 明细行都会显示 $0.42
    expect(screen.getAllByText('$0.42').length).toBeGreaterThan(0)
    // assistant 消息的 token 明细
    expect(screen.getByText('12.0k')).toBeInTheDocument()
    expect(screen.getByText('800')).toBeInTheDocument()
    expect(screen.getByText('100 / 50')).toBeInTheDocument()
  })

  it('expands a raw message entry', () => {
    useSessionStatsMock.mockReturnValue({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      contextUsed: 0,
      contextLimit: 200_000,
      contextPercent: 0,
      contextEstimated: true,
    })

    renderDialog()

    fireEvent.click(screen.getByText('assistant • entry-assistant-1'))
    // 展开后原始 JSON 里包含模型字段（Stat 里也显示一次，故用 getAllByText）
    expect(screen.getAllByText(/claude-sonnet-4/).length).toBeGreaterThan(1)
  })
})
