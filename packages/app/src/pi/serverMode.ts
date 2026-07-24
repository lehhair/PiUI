/** Shared flag: piui-server is the backend (not OpenCode). */

let _piServerUp = false

export function setPiServerReachable(up: boolean) {
  _piServerUp = up
}

export function isPiServerReachable(): boolean {
  return _piServerUp
}
