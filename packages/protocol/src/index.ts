export * from "./version.js"
export * from "./json.js"
export * from "./problem.js"
export * from "./commands.js"
export * from "./envelope.js"
export * from "./registry.js"
export * from "./workspace.js"
export * from "./git.js"
export * from "./extension-ui.js"
export * from "./session-page.js"
export * from "./provider-auth.js"
export * from "./terminal.js"

export type HealthResponse = {
  ok: true
  protocolVersion: typeof import("./version.js").PROTOCOL_VERSION
  service: "piui-server"
  piSdkVersion: string
  processId?: number
}

/**
 * Share info for letting another client reach this server. Only served to
 * authenticated callers: anyone who can read it already holds the token.
 */
export type ShareInfo = {
  /** Base URL other clients should use. */
  url: string
  /** Bearer token they must present. */
  token: string
  /** piui://connect link carrying both, pasteable in the add-server form. */
  link: string
  /** True when the server is reachable beyond this machine. */
  lan: boolean
}
