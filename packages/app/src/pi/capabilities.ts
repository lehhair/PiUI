import { useSyncExternalStore } from "react"
import { getPiNativeStatus, subscribePiNativeStatus } from "./nativeStatus"

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

/**
 * Capability -> registry command name (null: no backing command yet).
 * Capabilities derive natively from the Pi registry — a feature is
 * available exactly when the backend registry advertises its command.
 */
const COMMAND_MAP: Record<keyof PiCapabilities, string | null> = {
  pty: null,
  share: null,
  fork: 'fork',
  sessionTree: 'tree.get',
  sessionNavigate: 'navigateTree',
  sessionDelete: 'session.delete',
  sessionClone: 'clone',
  sessionImport: 'importSession',
  promptSteer: 'steer',
  promptFollowUp: 'followUp',
  queueManage: 'clearQueue',
  retryManage: 'setAutoRetry',
  compactionManage: 'compact',
  toolsManage: 'setActiveTools',
  fileWrite: null,
  gitDiff: null,
  sessionRename: 'setSessionName',
  sessionArchive: null,
  mcp: null,
  worktree: null,
  config: 'settings.get',
}

let cachedRegistry: unknown = undefined
let cachedResult: PiCapabilities = unavailable

export function getPiCapabilities(): PiCapabilities {
  const registry = getPiNativeStatus().registry
  if (!registry) return unavailable
  if (registry === cachedRegistry) return cachedResult
  const names = new Set([
    ...registry.globalCommands.map(command => command.name),
    ...registry.sessionCommands.map(command => command.name),
  ])
  const result = { ...unavailable }
  for (const [key, command] of Object.entries(COMMAND_MAP)) {
    if (command && names.has(command)) result[key as keyof PiCapabilities] = true
  }
  cachedRegistry = registry
  cachedResult = result
  return result
}

export function usePiCapabilities(): PiCapabilities {
  return useSyncExternalStore(subscribePiNativeStatus, getPiCapabilities, getPiCapabilities)
}
