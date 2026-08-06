import { beforeEach, describe, expect, it, vi } from 'vitest'
import { restartDesktopService, startDesktopService, stopDesktopService } from './desktopService'

const { invokeMock, applyLocalServerConfigMock, serviceStoreMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  applyLocalServerConfigMock: vi.fn(),
  serviceStoreMock: {
    envVarsRecord: { PIUI_USE_SYSTEM_PI: '1' },
    setRunning: vi.fn(),
    setStartedByUs: vi.fn(),
    setStarting: vi.fn(),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('../store/serverStore', () => ({ applyLocalServerConfig: applyLocalServerConfigMock }))
vi.mock('../store/serviceStore', () => ({ serviceStore: serviceStoreMock }))

const runningStatus = {
  running: true,
  startedByUs: true,
  pid: 42,
  url: 'http://127.0.0.1:8787',
  environment: { PIUI_USE_SYSTEM_PI: '1' },
}

describe('desktopService', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    applyLocalServerConfigMock.mockReset()
    serviceStoreMock.setRunning.mockReset()
    serviceStoreMock.setStartedByUs.mockReset()
    serviceStoreMock.setStarting.mockReset()
  })

  it('starts the service, applies credentials, and synchronizes status', async () => {
    invokeMock
      .mockResolvedValueOnce({
        started: true,
        startedByUs: true,
        url: 'http://127.0.0.1:8787',
        token: 'token',
      })
      .mockResolvedValueOnce(runningStatus)

    const outcome = await startDesktopService()

    expect(outcome.status).toEqual(runningStatus)
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'start_piui_service', {
      envVars: { PIUI_USE_SYSTEM_PI: '1' },
    })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'get_piui_service_status', {
      envVars: { PIUI_USE_SYSTEM_PI: '1' },
    })
    expect(applyLocalServerConfigMock).toHaveBeenCalledWith('http://127.0.0.1:8787', 'token')
  })

  it('uses the same validation and state path for restart', async () => {
    invokeMock.mockResolvedValueOnce({ started: true, startedByUs: true, url: null, token: null })

    await expect(restartDesktopService()).rejects.toThrow(/usable URL and auth token/)
    expect(invokeMock).toHaveBeenCalledWith('restart_piui_service', {
      envVars: { PIUI_USE_SYSTEM_PI: '1' },
    })
    expect(applyLocalServerConfigMock).not.toHaveBeenCalled()
  })

  it('stops the service and refreshes the authoritative status', async () => {
    const stoppedStatus = { ...runningStatus, running: false, startedByUs: false, pid: null, url: null }
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(stoppedStatus)

    await expect(stopDesktopService()).resolves.toEqual(stoppedStatus)
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'stop_piui_service')
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'get_piui_service_status', {
      envVars: { PIUI_USE_SYSTEM_PI: '1' },
    })
  })
})
