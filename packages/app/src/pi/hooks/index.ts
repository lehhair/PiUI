import { useSyncExternalStore } from 'react'
import { piSessionInfoStore, piBranchStore, piSessionStateStore } from '../state/index.js'

/**
 * React bindings for Pi stores.
 * Follows app convention: useSyncExternalStore with stable snapshots.
 */

export function usePiSessionInfos() {
  return useSyncExternalStore(
    piSessionInfoStore.subscribe,
    () => piSessionInfoStore.getAll(),
    () => piSessionInfoStore.getAll(),
  )
}

export function usePiBranchData() {
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => piBranchStore.getData(),
    () => piBranchStore.getData(),
  )
}

export function usePiBranchLoading() {
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => piBranchStore.isLoading(),
    () => piBranchStore.isLoading(),
  )
}

export function usePiSessionRuntimeState() {
  return useSyncExternalStore(
    piSessionStateStore.subscribe,
    () => piSessionStateStore.getState(),
    () => piSessionStateStore.getState(),
  )
}
