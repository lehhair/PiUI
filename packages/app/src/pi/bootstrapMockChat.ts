/** PiUI backend bootstrap. Mock seeding is intentionally a separate dev-only step. */
import { applySnapshotToUi } from "./applySnapshot"
import { getApiBase, piFetch } from "./sessionApi"
import type { SessionSnapshotV1 } from "@piui/protocol"
import { setPiCapabilities } from "./capabilities"

export interface PiBackendBootstrapResult {
  available: boolean
  driver?: "mock" | "pi"
}

export async function initializePiBackend(): Promise<PiBackendBootstrapResult> {
  const base = getApiBase()
  try {
    const health = await piFetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(2000) })
    if (!health.ok) throw new Error(`health ${health.status}`)
    const body = (await health.json()) as {
      driver?: "mock" | "pi"
      protocolVersion?: number
      service?: string
      capabilities?: Record<string, boolean>
    }
    if (body.service !== "piui-server" || body.protocolVersion !== 1) {
      throw new Error("unexpected backend")
    }

    const { setPiServerReachable } = await import("./serverMode")
    setPiServerReachable(true)
    setPiCapabilities(body.capabilities)
    console.info("[PiUI] server up, driver=", body.driver ?? "unknown")
    const { ensurePiEventSocket } = await import("./eventSocket")
    ensurePiEventSocket()
    void import("../hooks/useModels").then(m => m.refreshModels?.()).catch(() => {})
    return { available: true, driver: body.driver }
  } catch (error) {
    const { setPiServerReachable } = await import("./serverMode")
    setPiServerReachable(false)
    setPiCapabilities(undefined)
    console.info("[PiUI] server not up — run npm run dev:server or npm run dev:server:pi")
    if (import.meta.env.DEV && error instanceof Error) {
      console.info("[PiUI] backend bootstrap:", error.message)
    }
    return { available: false }
  }
}

/** Create a demo session only for mock development and only on an empty route. */
export async function seedMockChatIfEnabled(): Promise<string | null> {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env
  if (env?.VITE_PIUI_MOCK === "0" || window.location.hash.includes("#/session/")) return null

  try {
    const res = await piFetch(`${getApiBase()}/api/v1/dev/mock-chat`, { method: "POST" })
    if (!res.ok) {
      console.warn("[PiUI] mock-chat failed", res.status)
      return null
    }
    const data = (await res.json()) as { snapshot: SessionSnapshotV1 }
    const sessionId = applySnapshotToUi(data.snapshot)
    window.dispatchEvent(new CustomEvent("piui:sessions-changed"))
    window.location.hash = `#/session/${sessionId}`
    console.info("[PiUI] mock chat seeded", sessionId)
    return sessionId
  } catch (err) {
    console.warn("[PiUI] bootstrap error", err)
    return null
  }
}

/** Compatibility wrapper for callers that still want the old one-shot bootstrap. */
export async function bootstrapMockChatIfEnabled(): Promise<string | null> {
  const backend = await initializePiBackend()
  return backend.available && backend.driver === "mock" ? seedMockChatIfEnabled() : null
}
