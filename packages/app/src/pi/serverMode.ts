/** PiUI has one supported backend. Reachability is tracked separately from mode. */

let _piServerUp = false

export function setPiServerReachable(up: boolean) {
  _piServerUp = up
}

export function isPiServerReachable(): boolean {
  return _piServerUp
}

/** This application must never fall back to an OpenCode transport. */
export function isPiUiBackendMode(): true {
  return true
}
