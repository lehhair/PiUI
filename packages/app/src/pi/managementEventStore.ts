import { useSyncExternalStore } from 'react'
import type { PackageProgressV1, ProviderAuthEventV1 } from '@piui/protocol'

export interface ProviderAuthFlowState {
  flowId: string
  providerId: string
  sessionId?: string
  event?: ProviderAuthEventV1
  notifications: unknown[]
}

export interface ManagementEventSnapshot {
  flows: Record<string, ProviderAuthFlowState>
  packageProgress: Record<string, PackageProgressV1>
  resourceRevisions: Record<string, string>
  providerRevision: number
}

let snapshot: ManagementEventSnapshot = {
  flows: {},
  packageProgress: {},
  resourceRevisions: {},
  providerRevision: 0,
}

const listeners = new Set<() => void>()
const streamListeners = new Set<() => void>()
const providerIds = new Set<string>()

function emit(next: ManagementEventSnapshot) {
  snapshot = next
  listeners.forEach(listener => listener())
}

export function getManagementEventSnapshot(): ManagementEventSnapshot {
  return snapshot
}

export function subscribeManagementEvents(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useManagementEvents(): ManagementEventSnapshot {
  return useSyncExternalStore(subscribeManagementEvents, getManagementEventSnapshot, getManagementEventSnapshot)
}

export function trackManagementProviders(ids: Iterable<string>): void {
  let changed = false
  for (const id of ids) {
    if (!id || providerIds.has(id)) continue
    providerIds.add(id)
    changed = true
  }
  if (changed) streamListeners.forEach(listener => listener())
}

export function getTrackedManagementProviders(): string[] {
  return [...providerIds]
}

export function subscribeManagementStreams(listener: () => void): () => void {
  streamListeners.add(listener)
  return () => streamListeners.delete(listener)
}

export function registerProviderAuthFlow(flowId: string, providerId: string, sessionId?: string): void {
  const current = snapshot.flows[flowId]
  emit({
    ...snapshot,
    flows: {
      ...snapshot.flows,
      [flowId]: {
        flowId,
        providerId,
        sessionId: sessionId ?? current?.sessionId,
        event: current?.event,
        notifications: current?.notifications ?? [],
      },
    },
  })
}

export function receiveProviderAuthEvent(event: ProviderAuthEventV1, sessionId?: string): void {
  const current = snapshot.flows[event.flowId]
  emit({
    ...snapshot,
    flows: {
      ...snapshot.flows,
      [event.flowId]: {
        flowId: event.flowId,
        providerId: event.providerId,
        sessionId: sessionId ?? current?.sessionId,
        event,
        notifications: event.type === 'notification'
          ? [...(current?.notifications ?? []), event.event]
          : current?.notifications ?? [],
      },
    },
  })
}

export function dismissProviderAuthFlow(flowId: string): void {
  if (!snapshot.flows[flowId]) return
  const flows = { ...snapshot.flows }
  delete flows[flowId]
  emit({ ...snapshot, flows })
}

export function clearProviderAuthEvent(flowId: string): void {
  const current = snapshot.flows[flowId]
  if (!current) return
  emit({
    ...snapshot,
    flows: { ...snapshot.flows, [flowId]: { ...current, event: undefined } },
  })
}

export function receiveProviderAuthUpdated(): void {
  emit({ ...snapshot, providerRevision: snapshot.providerRevision + 1 })
}

export function receivePackageProgress(progress: PackageProgressV1): void {
  emit({
    ...snapshot,
    packageProgress: { ...snapshot.packageProgress, [progress.commandId]: progress },
  })
}

export function receiveResourceRevision(workspacePath: string | undefined, revision: string): void {
  if (!workspacePath) return
  emit({
    ...snapshot,
    resourceRevisions: { ...snapshot.resourceRevisions, [workspacePath]: revision },
  })
}

export function resetManagementEvents(): void {
  providerIds.clear()
  emit({ flows: {}, packageProgress: {}, resourceRevisions: {}, providerRevision: 0 })
  streamListeners.forEach(listener => listener())
}
