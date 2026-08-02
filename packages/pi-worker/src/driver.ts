export type DriverMode = "mock" | "pi"

export function getDriverMode(env: NodeJS.ProcessEnv = process.env): DriverMode {
  const value = (env.PIUI_DRIVER ?? "mock").toLowerCase()
  return value === "pi" || value === "1" || value === "true" || value === "real" ? "pi" : "mock"
}
