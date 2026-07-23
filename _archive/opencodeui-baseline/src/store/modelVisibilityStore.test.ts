import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '../types/ui'

function model(providerId: string, id: string): ModelInfo {
  return {
    id,
    name: id,
    providerId,
    providerName: providerId,
  } as ModelInfo
}

function readHiddenKeys(): string[] {
  const key = Object.keys(localStorage).find(k => k.endsWith(':hidden-model-keys'))
  if (!key) return []
  const raw = localStorage.getItem(key)
  if (!raw) return []
  return JSON.parse(raw) as string[]
}

describe('modelVisibilityStore', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('writes the current hidden keys on every hide, not the previous snapshot', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const a = model('openai', 'gpt-4')
    const b = model('openai', 'gpt-4o')

    modelVisibilityStore.setVisible(a, false)
    expect(readHiddenKeys()).toEqual(['openai:gpt-4'])
    expect(modelVisibilityStore.isVisible(a)).toBe(false)

    modelVisibilityStore.setVisible(b, false)
    expect(readHiddenKeys()).toEqual(['openai:gpt-4', 'openai:gpt-4o'])
  })

  it('keeps re-enabled models visible after a full store reload', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const a = model('openai', 'gpt-4')
    const b = model('openai', 'gpt-4o')

    modelVisibilityStore.setManyVisible([a, b], false)
    modelVisibilityStore.setVisible(a, true)
    expect(readHiddenKeys()).toEqual(['openai:gpt-4o'])

    vi.resetModules()
    const reloaded = await import('./modelVisibilityStore')
    expect(reloaded.modelVisibilityStore.isVisible(a)).toBe(true)
    expect(reloaded.modelVisibilityStore.isVisible(b)).toBe(false)
    expect(reloaded.modelVisibilityStore.getSnapshot()).toEqual(['openai:gpt-4o'])
  })

  it('persists consecutive channel toggles through reload', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const models = [model('anthropic', 'claude-3'), model('anthropic', 'claude-4')]

    modelVisibilityStore.setManyVisible(models, false)
    modelVisibilityStore.setManyVisible(models, true)
    expect(readHiddenKeys()).toEqual([])

    vi.resetModules()
    const reloaded = await import('./modelVisibilityStore')
    expect(reloaded.modelVisibilityStore.isVisible(models[0])).toBe(true)
    expect(reloaded.modelVisibilityStore.isVisible(models[1])).toBe(true)
    expect(reloaded.modelVisibilityStore.getSnapshot()).toEqual([])
  })
})
