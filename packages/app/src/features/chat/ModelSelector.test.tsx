import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ModelSelector } from './ModelSelector'
import type { Model } from '@earendil-works/pi-ai'

type ModelInfo = Model<any>

function sdkModel(id: string, name: string, reasoning = true): ModelInfo {
  return {
    id,
    name,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
  } as ModelInfo
}

vi.mock('../../components/ui', () => ({
  DropdownMenu: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}))

vi.mock('../../hooks/useInputCapabilities', () => ({
  useInputCapabilities: () => ({ preferTouchUi: false }),
}))

const useHiddenModelKeysMock = vi.hoisted(() => vi.fn<() => string[]>(() => []))

vi.mock('../../store/modelVisibilityStore', () => ({
  useHiddenModelKeys: useHiddenModelKeysMock,
  modelVisibilityStore: {
    isVisible: () => true,
    setVisible: () => {},
    setManyVisible: () => {},
    subscribe: () => () => {},
    getSnapshot: () => [],
  },
}))

vi.mock('../../utils/modelUtils', () => ({
  getModelKey: (model: ModelInfo) => `${model.provider}:${model.id}`,
  groupModelsByProvider: (models: ModelInfo[]) => [
    {
      providerId: 'openai',
      providerName: 'OpenAI',
      models,
    },
  ],
  getRecentModels: () => [],
  recordModelUsage: vi.fn(),
  getPinnedModels: () => [],
  isModelPinned: () => false,
  toggleModelPin: vi.fn(),
}))

const MODELS: ModelInfo[] = [
  sdkModel('gpt-4.1', 'GPT-4.1', true),
  sdkModel('gpt-4o-mini', 'GPT-4o Mini', false),
]

describe('ModelSelector', () => {
  it('opens menu and selects a model', () => {
    const onSelect = vi.fn()

    render(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={onSelect} />)

    fireEvent.click(screen.getByTitle('GPT-4.1'))
    fireEvent.click(screen.getByText('GPT-4o Mini'))

    expect(onSelect).toHaveBeenCalledWith('openai:gpt-4o-mini', expect.objectContaining({ name: 'GPT-4o Mini' }))
  })

  it('exposes accessible combobox-like semantics for search and options', () => {
    render(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByTitle('GPT-4.1'))

    const searchInput = screen.getByRole('textbox', { name: 'Search models...' })
    const selectedOption = document.getElementById('ms-item-1') as HTMLButtonElement | null
    const pinButtons = screen.getAllByRole('button', { name: /Pin to top|Unpin/ })

    expect(selectedOption).not.toBeNull()
    expect(selectedOption).not.toContainElement(pinButtons[0])
    expect(pinButtons.length).toBeGreaterThan(0)

    fireEvent.change(searchInput, { target: { value: 'nope' } })

    expect(screen.getByRole('status')).toHaveTextContent('No models found')
  })

  it('opens from ArrowUp at the last model and allows tabbing to pin controls', async () => {
    render(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={vi.fn()} />)

    const trigger = screen.getByTitle('GPT-4.1')
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })

    const lastOption = document.getElementById('ms-item-2') as HTMLButtonElement | null
    await waitFor(() => expect(lastOption).toHaveFocus())

    fireEvent.keyDown(lastOption!, { key: 'Escape' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    const selectedOption = document.getElementById('ms-item-1') as HTMLButtonElement | null
    const firstPinButton = screen.getByRole('button', { name: /Pin to top: GPT-4.1/i })

    await waitFor(() => expect(selectedOption).toHaveFocus())

    fireEvent.keyDown(selectedOption!, { key: 'Tab' })

    await waitFor(() => expect(firstPinButton).toHaveFocus())
  })

  it('returns focus to the toolbar input after selecting a model', async () => {
    const onSelect = vi.fn()

    function ToolbarSelectorHarness() {
      const containerRef = useRef<HTMLDivElement>(null)

      return (
        <div ref={containerRef}>
          <textarea aria-label="Chat input" />
          <ModelSelector
            models={MODELS}
            selectedModelKey={'openai:gpt-4.1'}
            onSelect={onSelect}
            trigger="toolbar"
            constrainToRef={containerRef}
          />
        </div>
      )
    }

    render(<ToolbarSelectorHarness />)

    fireEvent.click(screen.getByTitle('GPT-4.1'))
    fireEvent.click(screen.getByText('GPT-4o Mini'))

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chat input' })).toHaveFocus())
    expect(onSelect).toHaveBeenCalledWith('openai:gpt-4o-mini', expect.objectContaining({ name: 'GPT-4o Mini' }))
  })

  it('does not keep mouse-clicked pin controls focused', () => {
    render(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByTitle('GPT-4.1'))

    const pinButton = screen.getByRole('button', { name: /Pin to top: GPT-4.1/i })
    fireEvent.click(pinButton, { detail: 1 })

    expect(pinButton).not.toHaveFocus()
  })

  it('hides models that are marked hidden in the visibility store', () => {
    // 模拟隐藏 GPT-4o Mini：hook 返回的隐藏键来自 modelVisibilityStore 快照
    useHiddenModelKeysMock.mockReturnValue(['openai:gpt-4o-mini'])

    render(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByTitle('GPT-4.1'))

    expect(screen.queryByText('GPT-4o Mini')).not.toBeInTheDocument()
    expect(screen.getAllByText('GPT-4.1').length).toBeGreaterThan(0)
  })
})
