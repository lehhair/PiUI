import { useSyncExternalStore } from "react"
import type { PiRegistrySnapshot } from "@piui/protocol"

export interface PiCapabilities {
  pty: boolean
  share: boolean
  fork: boolean
  sessionTree: boolean
  sessionNavigate: boolean
  sessionDelete: boolean
  sessionClone: boolean
  sessionImport: boolean
  promptSteer: boolean
  promptFollowUp: boolean
  queueManage: boolean
  retryManage: boolean
  compactionManage: boolean
  toolsManage: boolean
  fileWrite: boolean
  gitDiff: boolean
  sessionRename: boolean
  sessionArchive: boolean
  mcp: boolean
  worktree: boolean
  config: boolean
}

const unavailable: PiCapabilities = {
  pty: false,
  share: false,
  fork: false,
  sessionTree: false,
  sessionNavigate: false,
  sessionDelete: false,
  sessionClone: false,
  sessionImport: false,
  promptSteer: false,
  promptFollowUp: false,
  queueManage: false,
  retryManage: false,
  compactionManage: false,
  toolsManage: false,
  fileWrite: false,
  gitDiff: false,
  sessionRename: false,
  sessionArchive: false,
  mcp: false,
  worktree: false,
  config: false,
}

let current = unavailable
const listeners = new Set<() => void>()

export function setPiCapabilities(value: Partial<PiCapabilities> | undefined) {
  current = { ...unavailable, ...value }
  for (const listener of listeners) listener()
}

export function setPiRegistryCapabilities(registry: PiRegistrySnapshot | undefined) {
  if (!registry) {
    setPiCapabilities(undefined)
    return
  }
  // UI gates are enabled only after their native adapters are wired. The
  // registry itself remains available through nativeStatus for discovery.
  setPiCapabilities({})
}

export function getPiCapabilities(): PiCapabilities {
  return current
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePiCapabilities(): PiCapabilities {
  return useSyncExternalStore(subscribe, getPiCapabilities, getPiCapabilities)
}
