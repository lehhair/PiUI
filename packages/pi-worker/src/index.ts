export * from "./ipc.js"
export * from "./runtime.js"
export * from "./sdk-host.js"
export * from "./runtime/pagination.js"
export * from "./command-table.js"
export * from "./params.js"
export { RealPiSession, type ExtensionHostActions, type RealPiSessionOpenOptions } from "./runtime/real-session.js"
export { MockPiSession, MockCatalog, MockStore } from "./runtime/mock-session.js"
export { PiCatalog } from "./runtime/catalog.js"
export { ProviderAuthHost, type ProviderAuthEvent } from "./runtime/provider-auth-host.js"
export { ExtensionUiBridge, type PiExtensionUiEvent } from "./runtime/extension-ui-bridge.js"
export { createWorkerCommandScheduler } from "./worker-command-scheduler.js"

export type DriverMode = "mock" | "pi"

export function getDriverMode(env: NodeJS.ProcessEnv = process.env): DriverMode {
  const v = (env.PIUI_DRIVER ?? "mock").toLowerCase()
  return v === "pi" || v === "1" || v === "true" || v === "real" ? "pi" : "mock"
}

export function getPiWorkerEntryUrl(): URL {
  return new URL("./entry.js", import.meta.url)
}
