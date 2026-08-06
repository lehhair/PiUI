import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('serviceStore', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('keeps auto start enabled for a new PiUI install', async () => {
    const { serviceStore } = await import('./serviceStore')
    expect(serviceStore.autoStart).toBe(true)
  })

  it('maps the host Pi SDK toggle to the worker environment', async () => {
    const { serviceStore } = await import('./serviceStore')

    serviceStore.setUseSystemPiSdk(true)
    expect(serviceStore.useSystemPiSdk).toBe(true)
    expect(serviceStore.envVarsRecord.PIUI_USE_SYSTEM_PI).toBe('1')

    serviceStore.setUseSystemPiSdk(false)
    expect(serviceStore.useSystemPiSdk).toBe(false)
    expect(serviceStore.envVarsRecord.PIUI_USE_SYSTEM_PI).toBeUndefined()
  })

  it('upserts example variables without creating duplicate keys', async () => {
    const { serviceStore } = await import('./serviceStore')

    serviceStore.setEnvVars([{ key: 'https_proxy', value: 'old' }])
    serviceStore.upsertEnvVar('HTTPS_PROXY', 'http://127.0.0.1:7890')

    expect(serviceStore.envVars).toEqual([{ key: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' }])
  })
})
