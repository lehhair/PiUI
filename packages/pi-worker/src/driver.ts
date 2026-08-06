export type DriverMode = "mock" | "pi"

export function getDriverMode(env: NodeJS.ProcessEnv = process.env): DriverMode {
  const value = (env.PIUI_DRIVER ?? "mock").trim().toLowerCase()
  if (value === "pi" || value === "1" || value === "true" || value === "real") return "pi"
  if (value === "mock" || value === "0" || value === "false") return "mock"
  throw Object.assign(new Error(`PIUI_DRIVER must be pi or mock, received: ${env.PIUI_DRIVER}`), { code: "INVALID_CONFIGURATION" })
}
