// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiSessionManagement } from './PiSessionManagement'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const { setScopedModelsMock, loadSessionsMock, exportPiSessionMock } = vi.hoisted(() => ({
  setScopedModelsMock: vi.fn(),
  loadSessionsMock: vi.fn(),
  exportPiSessionMock: vi.fn(),
}))

vi.mock('../../../pi/controllers/index.js', () => ({
  abortPiBashExecution: vi.fn(),
  appendPiCustomEntry: vi.fn(),
  cyclePiModel: vi.fn(),
  cyclePiThinkingLevel: vi.fn(),
  executePiBash: vi.fn(),
  exportPiSession: (...args: unknown[]) => exportPiSessionMock(...args),
  loadPiSessionsForCwd: () => loadSessionsMock(),
  newPiSessionFrom: vi.fn(),
  openPiSession: vi.fn(),
  sendPiCustomMessage: vi.fn(),
  sendPiPrompt: vi.fn(),
  sendPiUserMessage: vi.fn(),
  setPiScopedModels: (...args: unknown[]) => setScopedModelsMock(...args),
  waitForPiIdle: vi.fn(),
}))

vi.mock('../../../pi/hooks/index.js', () => ({
  usePiSessionRuntimeState: () => ({
    scopedModels: ['anthropic:claude-sonnet-4', 'openai:gpt-5'],
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4' },
    thinkingLevel: 'off',
    isStreaming: false,
  }),
}))

function scopedModelsTextarea(): HTMLTextAreaElement {
  // 第一个 textarea 是 scoped models 输入（第二个是 custom payload）
  const areas = screen.getAllByRole('textbox').filter((el): el is HTMLTextAreaElement => el instanceof HTMLTextAreaElement)
  return areas[0]
}

describe('PiSessionManagement scoped models', () => {
  beforeEach(() => {
    setScopedModelsMock.mockReset().mockResolvedValue(undefined)
    loadSessionsMock.mockReset().mockResolvedValue([])
    exportPiSessionMock.mockReset().mockResolvedValue({ path: 'E:\\out.jsonl' })
  })

  it('shows the current native scoped model patterns', async () => {
    render(<PiSessionManagement sessionId="session-1" workspacePath="E:\\workspace" />)

    await waitFor(() => {
      expect(scopedModelsTextarea().value).toBe('anthropic:claude-sonnet-4\nopenai:gpt-5')
    })
  })

  it('applies trimmed, non-empty patterns through the native command', async () => {
    render(<PiSessionManagement sessionId="session-1" workspacePath="E:\\workspace" />)

    await waitFor(() => {
      expect(scopedModelsTextarea().value).toBe('anthropic:claude-sonnet-4\nopenai:gpt-5')
    })
    fireEvent.change(scopedModelsTextarea(), { target: { value: ' anthropic:claude-sonnet-4 \n\nopenai:gpt-5 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'pi.applyModelScope' }))

    await waitFor(() => {
      expect(setScopedModelsMock).toHaveBeenCalledWith('session-1', ['anthropic:claude-sonnet-4', 'openai:gpt-5'])
    })
  })
})

describe('PiSessionManagement exports', () => {
  beforeEach(() => {
    setScopedModelsMock.mockReset().mockResolvedValue(undefined)
    loadSessionsMock.mockReset().mockResolvedValue([])
    exportPiSessionMock.mockReset().mockResolvedValue({ path: 'E:\\out.jsonl' })
  })

  it('exports the session as HTML and JSONL to the given path', async () => {
    render(<PiSessionManagement sessionId="session-1" workspacePath="E:\\workspace" />)

    const outputPath = await screen.findByPlaceholderText('pi.outputPath')
    fireEvent.change(outputPath, { target: { value: 'E:\\out' } })

    fireEvent.click(screen.getByRole('button', { name: 'pi.exportHtml' }))
    await waitFor(() => {
      expect(exportPiSessionMock).toHaveBeenCalledWith('session-1', 'html', 'E:\\out')
    })

    fireEvent.click(screen.getByRole('button', { name: 'pi.exportJsonl' }))
    await waitFor(() => {
      expect(exportPiSessionMock).toHaveBeenCalledWith('session-1', 'jsonl', 'E:\\out')
    })

    expect(await screen.findByText(/E:\\\\out/)).toBeInTheDocument()
  })
})
