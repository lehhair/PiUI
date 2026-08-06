import { afterEach, describe, expect, it, vi } from 'vitest'
import { getApiBase, piFetch } from './httpClient'
import { LOCAL_SERVER_ID, serverStore } from '../store/serverStore'

const nativeFetchMock = vi.hoisted(() => vi.fn())

vi.mock('../utils/tauri', () => ({
  isTauri: () => true,
  getHttpFetch: () => Promise.resolve(nativeFetchMock),
}))

describe('Tauri HTTP transport', () => {
  const original = serverStore.getStoredServers().find(server => server.id === LOCAL_SERVER_ID)

  afterEach(() => {
    vi.unstubAllEnvs()
    nativeFetchMock.mockReset()
    if (original) serverStore.updateServer(LOCAL_SERVER_ID, { url: original.url, token: original.token })
  })

  it('uses the selected desktop server instead of a build-time VITE_PIUI_API', () => {
    vi.stubEnv('VITE_PIUI_API', 'https://build-time.invalid')
    serverStore.updateServer(LOCAL_SERVER_ID, { url: 'https://settings.example.test' })

    expect(getApiBase()).toBe('https://settings.example.test')
  })

  it('uses plugin-http with the selected server Bearer token on Android', async () => {
    serverStore.updateServer(LOCAL_SERVER_ID, {
      url: 'http://192.168.1.10:8787',
      token: 'mobile-token',
    })
    nativeFetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))

    await piFetch(`${getApiBase()}/api/v1/host/health`)

    expect(nativeFetchMock).toHaveBeenCalledWith(
      'http://192.168.1.10:8787/api/v1/host/health',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    const headers = nativeFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer mobile-token')
  })
})
