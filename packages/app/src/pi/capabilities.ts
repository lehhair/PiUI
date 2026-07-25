import { useSyncExternalStore } from "react"
import type { CapabilityManifestV2, PiCapabilityId } from "@piui/protocol"

export interface PiCapabilities {
  pty: boolean
  share: boolean
  fork: boolean
  undo: boolean
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
  undo: false,
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

export function setPiCapabilityManifest(manifest: CapabilityManifestV2) {
  const enabled = (id: PiCapabilityId) => manifest.capabilities[id]?.enabled === true
  setPiCapabilities({
    pty: enabled("pty"),
    share: enabled("session.share"),
    fork: enabled("session.fork"),
    undo: enabled("session.navigate"),
    fileWrite: enabled("files.write"),
    gitDiff: enabled("git.diff"),
    sessionRename: enabled("session.name"),
    sessionArchive: enabled("session.archive"),
    mcp: enabled("integrations.mcp"),
    worktree: enabled("git.worktree"),
    config: enabled("settings.manage"),
  })
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
