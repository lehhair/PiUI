import { applyLocalServerConfig } from '../store/serverStore'
import { serviceStore } from '../store/serviceStore'

export interface DesktopServiceStatus {
  running: boolean
  startedByUs: boolean
  pid?: number | null
  url?: string | null
  environment: Record<string, string>
}

export interface DesktopServiceStartResult {
  started: boolean
  startedByUs: boolean
  url?: string | null
  token?: string | null
}

export interface DesktopServiceStartOutcome {
  result: DesktopServiceStartResult
  status: DesktopServiceStatus
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

let invokePromise: Promise<Invoke> | null = null
let pendingOperations = 0

async function getInvoke(): Promise<Invoke> {
  invokePromise ??= import('@tauri-apps/api/core').then(module => module.invoke as Invoke)
  return invokePromise
}

function environmentArgs(): { envVars: Record<string, string> } {
  return { envVars: serviceStore.envVarsRecord }
}

function applyStatus(status: DesktopServiceStatus): DesktopServiceStatus {
  serviceStore.setRunning(status.running)
  serviceStore.setStartedByUs(status.startedByUs)
  return status
}

async function withOperation<T>(operation: () => Promise<T>): Promise<T> {
  pendingOperations += 1
  serviceStore.setStarting(true)
  try {
    return await operation()
  } finally {
    pendingOperations -= 1
    serviceStore.setStarting(pendingOperations > 0)
  }
}

export async function refreshDesktopServiceStatus(): Promise<DesktopServiceStatus> {
  const invoke = await getInvoke()
  return applyStatus(await invoke<DesktopServiceStatus>('get_piui_service_status', environmentArgs()))
}

async function startOrRestartDesktopService(
  command: 'start_piui_service' | 'restart_piui_service',
): Promise<DesktopServiceStartOutcome> {
  return withOperation(async () => {
    const invoke = await getInvoke()
    const result = await invoke<DesktopServiceStartResult>(command, environmentArgs())
    if (!result.url || !result.token) {
      throw new Error('PiUI server did not return a usable URL and auth token')
    }
    applyLocalServerConfig(result.url, result.token)
    serviceStore.setRunning(true)
    serviceStore.setStartedByUs(result.startedByUs)
    return { result, status: await refreshDesktopServiceStatus() }
  })
}

export function startDesktopService(): Promise<DesktopServiceStartOutcome> {
  return startOrRestartDesktopService('start_piui_service')
}

export function restartDesktopService(): Promise<DesktopServiceStartOutcome> {
  return startOrRestartDesktopService('restart_piui_service')
}

export function stopDesktopService(): Promise<DesktopServiceStatus> {
  return withOperation(async () => {
    const invoke = await getInvoke()
    await invoke('stop_piui_service')
    serviceStore.setRunning(false)
    serviceStore.setStartedByUs(false)
    return refreshDesktopServiceStatus()
  })
}
