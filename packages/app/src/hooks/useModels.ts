import { useSyncExternalStore, useCallback } from 'react'
import { listPiModels } from '../pi/sessionApi'

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
  family: string
  contextLimit: number
  outputLimit: number
  supportsReasoning: boolean
  supportsImages: boolean
  supportsPdf: boolean
  supportsAudio: boolean
  supportsVideo: boolean
  supportsToolcall: boolean
  variants: string[]
}

export interface FileCapabilities {
  image: boolean
  pdf: boolean
  audio: boolean
  video: boolean
}

// ============================================
// Global singleton so every ChatPane shares one models array.
// Prevents duplicate API requests and the race condition where a
// late-mounting pane sees an empty models list, falls back to
// models[0], and overwrites the persisted model selection.
// ============================================

interface ModelsState {
  models: ModelInfo[]
  isLoading: boolean
  error: Error | null
}

type Listener = () => void

let _state: ModelsState = { models: [], isLoading: true, error: null }
let _fetchPromise: Promise<void> | null = null
let _fetchGeneration = 0
const _listeners = new Set<Listener>()

function _notify() {
  for (const fn of _listeners) fn()
}

function _setState(patch: Partial<ModelsState>) {
  _state = { ..._state, ...patch }
  _notify()
}

async function _fetchModels(force = false) {
  if (_fetchPromise && !force) return _fetchPromise

  const generation = ++_fetchGeneration

  _fetchPromise = (async () => {
    _setState({ isLoading: true, error: null })
    try {
      const { models } = await listPiModels()
      const data: ModelInfo[] = models.map(model => ({
        id: model.id,
        name: model.name,
        providerId: model.provider,
        providerName: model.provider,
        family: model.api,
        contextLimit: model.contextWindow,
        outputLimit: model.maxTokens,
        supportsReasoning: model.reasoning,
        supportsImages: model.input.includes('image'),
        supportsPdf: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsToolcall: true,
        variants: getThinkingLevels(model),
      }))
      if (generation === _fetchGeneration) {
        _setState({ models: data, isLoading: false })
      }
    } catch (e) {
      if (generation === _fetchGeneration) {
        _setState({ error: e instanceof Error ? e : new Error('Failed to fetch models'), isLoading: false })
      }
    } finally {
      if (generation === _fetchGeneration) {
        _fetchPromise = null
      }
    }
  })()

  return _fetchPromise
}

function getThinkingLevels(model: Awaited<ReturnType<typeof listPiModels>>['models'][number]): string[] {
  if (!model.reasoning) return ['off']
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(level => {
    const mapped = model.thinkingLevelMap?.[level as keyof typeof model.thinkingLevelMap]
    return mapped !== null && (level !== 'xhigh' && level !== 'max' || mapped !== undefined)
  })
}

export function refreshModels() {
  return _fetchModels(true)
}

function _subscribe(listener: Listener) {
  _listeners.add(listener)
  return () => _listeners.delete(listener)
}

function _getSnapshot(): ModelsState {
  return _state
}

// ============================================
// Hook — drop-in replacement, same return type
// ============================================

interface UseModelsResult {
  models: ModelInfo[]
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<void>
}

export function useModels(): UseModelsResult {
  const state = useSyncExternalStore(_subscribe, _getSnapshot)
  const refetch = useCallback(() => refreshModels(), [])

  return {
    models: state.models,
    isLoading: state.isLoading,
    error: state.error,
    refetch,
  }
}
