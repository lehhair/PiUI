import { afterEach, describe, expect, it, vi } from 'vitest'
import { getApiBase } from './httpClient'
import { LOCAL_SERVER_ID, serverStore } from '../store/serverStore'

vi.mock('../utils/tauri', () => ({
  isTauri: () => true,
  getHttpFetch: () => Promise.resolve(fetch),
}))

describe('desktop HTTP endpoint selection', () => {
  const originalUrl = serverStore.getStoredServers().find(server => server.id === LOCAL_SERVER_ID)?.url

  afterEach(() => {
    vi.unstubAllEnvs()
    if (originalUrl) serverStore.updateServer(LOCAL_SERVER_ID, { url: originalUrl })
  })

  it('uses the selected desktop server instead of a build-time VITE_PIUI_API', () => {
    vi.stubEnv('VITE_PIUI_API', 'https://build-time.invalid')
    serverStore.updateServer(LOCAL_SERVER_ID, { url: 'https://settings.example.test' })

    expect(getApiBase()).toBe('https://settings.example.test')
  })
})
