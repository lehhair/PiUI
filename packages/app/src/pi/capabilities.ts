export interface PiCapabilities {
  pty: boolean
  share: boolean
  fork: boolean
  undo: boolean
  fileWrite: boolean
  gitDiff: boolean
}

const unavailable: PiCapabilities = {
  pty: false,
  share: false,
  fork: false,
  undo: false,
  fileWrite: false,
  gitDiff: false,
}

let current = unavailable
const listeners = new Set<() => void>()

export function setPiCapabilities(value: Partial<PiCapabilities> | undefined) {
  current = { ...unavailable, ...value }
  for (const listener of listeners) listener()
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
import { useSyncExternalStore } from "react"
