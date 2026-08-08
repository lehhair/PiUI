// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BashRenderer } from './BashRenderer'
import { liveToolOutputStore } from '../../../../pi/liveToolOutput'
import type { ExtractedToolData } from '../types'
import type { PiToolExecution } from '../../../../pi/domain/index.js'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'bash.truncatedNotice') return `Output truncated — full log at ${options?.path ?? ''}`
      if (key === 'contentBlock.exitCode') return `exit ${options?.code ?? ''}`
      return key
    },
  }),
}))

vi.mock('../../../../contexts', () => ({
  useFullscreen: () => ({
    activeId: null,
    openFullscreen: vi.fn(),
    updateFullscreen: vi.fn(),
    closeFullscreen: vi.fn(),
  }),
}))

vi.mock('../../../../hooks/useSyntaxHighlight', () => ({
  useSyntaxHighlight: () => ({}),
}))

vi.mock('../../../../hooks/useResponsiveMaxHeight', () => ({
  useResponsiveMaxHeight: () => undefined,
}))

vi.mock('../../../../utils', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils')>('../../../../utils')
  return {
    ...actual,
    copyTextToClipboard: vi.fn(),
    clipboardErrorHandler: vi.fn(),
  }
})

function runningExecution(toolCallId = 'call-1'): PiToolExecution {
  return {
    call: { type: 'toolCall', id: toolCallId, name: 'bash', arguments: { command: 'echo hi' } },
    result: undefined,
  }
}

function completedExecution(): PiToolExecution {
  return {
    call: { type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'make build' } },
    result: {
      role: 'toolResult',
      toolCallId: 'call-2',
      toolName: 'bash',
      content: [{ type: 'text', text: 'truncated output...' }],
      isError: false,
      timestamp: 0,
      details: { truncated: true, fullOutputPath: '/tmp/pi-bash-abc.log', exitCode: 0 },
    },
  }
}

function renderBash(execution: PiToolExecution, data: ExtractedToolData) {
  return render(
    <BashRenderer
      execution={execution}
      partKey="p1"
      data={data}
      onFullscreenChange={vi.fn()}
    />,
  )
}

describe('BashRenderer', () => {
  beforeEach(() => liveToolOutputStore.clearAll())

  it('streams live tool output into a running bash card', async () => {
    const execution = runningExecution()
    renderBash(execution, { input: 'echo hi' })

    act(() => {
      liveToolOutputStore.set('call-1', 'session-1', 'building...\nprogress line')
    })

    expect(await screen.findByText(/building/)).toBeInTheDocument()
    expect(screen.getByText(/progress line/)).toBeInTheDocument()
  })

  it('prefers the persisted result output once the tool completes', async () => {
    renderBash(completedExecution(), { output: 'final output', truncated: true, fullOutputPath: '/tmp/pi-bash-abc.log' })

    expect(await screen.findByText(/final output/)).toBeInTheDocument()
  })

  it('shows a native truncation notice with the full log path', async () => {
    renderBash(completedExecution(), { output: 'truncated output...', truncated: true, fullOutputPath: '/tmp/pi-bash-abc.log' })

    expect(await screen.findByText('Output truncated — full log at /tmp/pi-bash-abc.log')).toBeInTheDocument()
  })

  it('hides the truncation notice when there is no full log path', () => {
    renderBash(completedExecution(), { output: 'truncated output...', truncated: true })
    expect(screen.queryByText(/Output truncated/)).not.toBeInTheDocument()
  })
})
