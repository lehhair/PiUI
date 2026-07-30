import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ModelsSettings } from './ModelsSettings'
import type { AnyModel } from '../../../utils/modelUtils'

const { usePiModelsMock, useHiddenModelKeysMock, setVisibleMock, setManyVisibleMock } = vi.hoisted(() => ({
  usePiModelsMock: vi.fn(),
  useHiddenModelKeysMock: vi.fn(),
  setVisibleMock: vi.fn(),
  setManyVisibleMock: vi.fn(),
}))

vi.mock('../../../pi/hooks/index.js', () => ({
  usePiModels: usePiModelsMock,
}))

vi.mock('../../../store', () => ({
  modelVisibilityStore: {
    setVisible: setVisibleMock,
    setManyVisible: setManyVisibleMock,
  },
  useHiddenModelKeys: useHiddenModelKeysMock,
}))

vi.mock('../../../utils/modelUtils', () => ({
  getModelKey: (model: AnyModel) => `${model.provider}:${model.id}`,
  groupModelsByProvider: (models: AnyModel[]) => [
    {
      providerId: 'openai',
      providerName: 'openai',
      models,
    },
  ],
}))

function makeModel(id: string, name: string): AnyModel {
  return {
    id,
    name,
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
  } as AnyModel
}

const MODELS: AnyModel[] = [
  makeModel('gpt-4.1', 'GPT-4.1'),
  makeModel('gpt-4o-mini', 'GPT-4o Mini'),
]

describe('ModelsSettings', () => {
  beforeEach(() => {
    usePiModelsMock.mockReturnValue({ models: MODELS, isLoading: false })
    useHiddenModelKeysMock.mockReturnValue([])
    setVisibleMock.mockReset()
    setManyVisibleMock.mockReset()
  })

  it('renders model rows with semantic buttons and labeled switches', () => {
    render(<ModelsSettings />)

    const modelButton = screen.getByRole('button', { name: /GPT-4.1/i })
    const switches = screen.getAllByRole('switch')

    fireEvent.click(modelButton)

    expect(modelButton).toHaveAttribute('aria-pressed', 'true')
    expect(switches[0]).toHaveAttribute('aria-label', 'Hide GPT-4.1')
    expect(setVisibleMock).toHaveBeenCalledWith(MODELS[0], false)
  })

  it('keeps the whole model row clickable outside the text button and switch', () => {
    render(<ModelsSettings />)

    const modelButton = screen.getByRole('button', { name: /GPT-4.1/i })
    const modelRow = modelButton.parentElement

    expect(modelRow).not.toBeNull()

    fireEvent.click(modelRow!)

    expect(setVisibleMock).toHaveBeenCalledWith(MODELS[0], false)
  })

  it('reflects each model visibility state', () => {
    useHiddenModelKeysMock.mockReturnValue(['openai:gpt-4.1'])

    render(<ModelsSettings />)

    const switches = screen.getAllByRole('switch')

    expect(switches).toHaveLength(2)
    expect(switches[0]).toHaveAttribute('aria-checked', 'false')
    expect(switches[1]).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(setManyVisibleMock).toHaveBeenCalledWith(MODELS, true)
  })
})
