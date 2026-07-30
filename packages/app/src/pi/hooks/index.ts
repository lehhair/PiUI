import { useSyncExternalStore } from 'react'
import { useMemo } from 'react'
import { piSessionInfoStore, piBranchStore, piSessionStateStore, piModelsStore } from '../state/index.js'

/**
 * React bindings for Pi stores.
 * Session-scoped hooks take sessionId (null yields empty snapshots),
 * keeping multi-pane renders isolated per session.
 */

export function usePiSessionInfos() {
  return useSyncExternalStore(
    piSessionInfoStore.subscribe,
    () => piSessionInfoStore.getAll(),
    () => piSessionInfoStore.getAll(),
  )
}

export function usePiBranchData(sessionId: string | null) {
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => (sessionId ? piBranchStore.getData(sessionId) : null),
    () => (sessionId ? piBranchStore.getData(sessionId) : null),
  )
}

export function usePiBranchLoading(sessionId: string | null) {
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => (sessionId ? piBranchStore.isLoading(sessionId) : false),
    () => (sessionId ? piBranchStore.isLoading(sessionId) : false),
  )
}

export function usePiSessionRuntimeState(sessionId: string | null) {
  return useSyncExternalStore(
    piSessionStateStore.subscribe,
    () => (sessionId ? piSessionStateStore.getState(sessionId) : null),
    () => (sessionId ? piSessionStateStore.getState(sessionId) : null),
  )
}

export function usePiModels() {
  const models = useSyncExternalStore(
    piModelsStore.subscribe,
    () => piModelsStore.getModels(),
    () => piModelsStore.getModels(),
  )
  const isLoading = useSyncExternalStore(
    piModelsStore.subscribe,
    () => piModelsStore.isLoading(),
    () => piModelsStore.isLoading(),
  )
  return { models, isLoading }
}

/**
 * Session display title, same chain as the session list:
 * runtime sessionName -> SessionInfo.name -> firstMessage.
 */
export function usePiSessionTitle(sessionId: string | null): string | null {
  const state = usePiSessionRuntimeState(sessionId)
  const sessionInfos = usePiSessionInfos()
  return useMemo(() => {
    if (!sessionId) return null
    const stateName = typeof state?.sessionName === 'string' && state.sessionName.trim() ? state.sessionName.trim() : null
    if (stateName) return stateName
    const info = sessionInfos.find(item => item.id === sessionId)
    return info?.name?.trim() || info?.firstMessage?.trim() || null
  }, [sessionId, state?.sessionName, sessionInfos])
}
