import { useSyncExternalStore } from "react"
import type { ProtocolHandshakeV2 } from "@piui/protocol"

export type PiBackendStatus = "booting" | "online" | "offline" | "unauthorized"

export interface PiBackendState {
  status: PiBackendStatus
  driver?: "mock" | "pi"
  handshake?: ProtocolHandshakeV2
  error?: string
  checkedAt?: number
}

let state: PiBackendState = { status: "booting" }
const listeners = new Set<() => void>()

export function setPiBackendState(next: PiBackendState): void {
  state = next
  for (const listener of listeners) listener()
}

export function getPiBackendState(): PiBackendState {
  return state
}

export function usePiBackendState(): PiBackendState {
  return useSyncExternalStore(subscribe, getPiBackendState, getPiBackendState)
}

export function setPiServerReachable(up: boolean) {
  setPiBackendState(up
    ? { ...state, status: "online", error: undefined, checkedAt: Date.now() }
    : { ...state, status: "offline", checkedAt: Date.now() })
}

export function isPiServerReachable(): boolean {
  return state.status === "online"
}

/** This application must never fall back to an OpenCode transport. */
export function isPiUiBackendMode(): true {
  return true
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
