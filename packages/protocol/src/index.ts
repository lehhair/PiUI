export * from "./version.js"
export * from "./json.js"
export * from "./problem.js"
export * from "./commands.js"
export * from "./envelope.js"
export * from "./registry.js"
export * from "./workspace.js"
export * from "./git.js"
export * from "./extension-ui.js"

export type HealthResponse = {
  ok: true
  protocolVersion: typeof import("./version.js").PROTOCOL_VERSION
  service: "piui-server"
  piSdkVersion: string
}
