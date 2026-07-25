export * from "./types.js"
export * from "./projection.js"
export * from "./mock-runtime.js"
// RealPiSession class is heavy — load via loadRealPiSession() when PIUI_DRIVER=pi
export type { PiSessionInfo, RealPiSession } from "./real-session.js"

export type DriverMode = "mock" | "pi"

export function getDriverMode(env: NodeJS.ProcessEnv = process.env): DriverMode {
  const v = (env.PIUI_DRIVER ?? env.PIUI_USE_REAL_PI ?? "mock").toLowerCase()
  if (v === "pi" || v === "1" || v === "true" || v === "real") return "pi"
  return "mock"
}

export async function loadRealPiSession() {
  const mod = await import("./real-session.js")
  return mod.RealPiSession
}
