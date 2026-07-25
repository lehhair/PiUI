export * from "./types.js"
export * from "./projection.js"
export * from "./mock-runtime.js"
export * from "./runtime-contract.js"
export * from "./worker-protocol.js"
export type {
  PiCommandInfo,
  PiRuntimeUiState,
  PiSessionInfo,
  PiSkillInfo,
  RealPiSession,
} from "./real-session.js"

export type DriverMode = "mock" | "pi"

export function getDriverMode(env: NodeJS.ProcessEnv = process.env): DriverMode {
  const v = (env.PIUI_DRIVER ?? env.PIUI_USE_REAL_PI ?? "mock").toLowerCase()
  if (v === "pi" || v === "1" || v === "true" || v === "real") return "pi"
  return "mock"
}

export function getPiWorkerEntryUrl(): URL {
  return new URL("./worker-entry.js", import.meta.url)
}
