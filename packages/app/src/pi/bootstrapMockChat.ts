/** PiUI backend bootstrap. Mock seeding is intentionally a separate dev-only step. */
import { applySnapshotToUi } from "./applySnapshot"
import { getApiBase, piFetch } from "./sessionApi"
import type { ProtocolHandshakeV2, SessionSnapshotV1 } from "@piui/protocol"
import { setPiCapabilities, setPiCapabilityManifest } from "./capabilities"
import { getPiBackendState, setPiBackendState } from "./serverMode"
import { serverStore } from "../store/serverStore"
import { clearPiSessionIndex } from "./piSessionIndex"
import { sessionProjectionStore } from "./sessionProjectionStore"
import { extensionUiStore } from "./extensionUiStore"
import { messageStore } from "../store/messageStore"
import { resetWorkspaceResolutionCache } from "./sessionApi"
import { resetManagementEvents } from "./managementEventStore"

export interface PiBackendBootstrapResult {
  available: boolean
  driver?: "mock" | "pi"
}

let initialization: Promise<PiBackendBootstrapResult> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryAttempt = 0
let serverSwitchInstalled = false

export async function initializePiBackend(): Promise<PiBackendBootstrapResult> {
  if (initialization) return initialization
  initialization = initializePiBackendOnce().finally(() => { initialization = null })
  return initialization
}

async function initializePiBackendOnce(): Promise<PiBackendBootstrapResult> {
  const base = getApiBase()
  setPiBackendState({ ...getPiBackendState(), status: "booting", error: undefined })
  try {
    const health = await piFetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(2000) })
    if (!health.ok) throw new Error(`health ${health.status}`)
    const body = (await health.json()) as {
      driver?: "mock" | "pi"
      protocolVersion?: number
      service?: string
      capabilities?: Record<string, boolean>
      protocolV2?: ProtocolHandshakeV2
    }
    if (body.service !== "piui-server" || body.protocolVersion !== 1) {
      throw new Error("unexpected backend")
    }

    if (!body.protocolV2) throw new Error("PiUI protocol v2 handshake is missing")
    setPiBackendState({
      status: "online",
      driver: body.driver,
      handshake: body.protocolV2,
      checkedAt: Date.now(),
    })
    if (body.protocolV2) setPiCapabilityManifest(body.protocolV2.capabilities)
    else setPiCapabilities(body.capabilities)
    console.info("[PiUI] server up, driver=", body.driver ?? "unknown")
    const { ensurePiEventSocket } = await import("./eventSocket")
    ensurePiEventSocket()
    void import("../hooks/useModels").then(m => m.refreshModels?.()).catch(() => {})
    retryAttempt = 0
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    return { available: true, driver: body.driver }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setPiBackendState({
      status: /health 401|health 403/.test(message) ? "unauthorized" : "offline",
      error: message,
      checkedAt: Date.now(),
    })
    setPiCapabilities(undefined)
    console.info("[PiUI] server not up — run npm run dev:server or npm run dev:server:pi")
    if (import.meta.env.DEV && error instanceof Error) {
      console.info("[PiUI] backend bootstrap:", error.message)
    }
    scheduleBackendRetry()
    return { available: false }
  }
}

export function installPiBackendServerSwitch(): void {
  if (serverSwitchInstalled) return
  serverSwitchInstalled = true
  serverStore.onServerChange(() => {
    clearPiSessionIndex()
    sessionProjectionStore.clear()
    extensionUiStore.reset()
    messageStore.clearAll()
    resetWorkspaceResolutionCache()
    resetManagementEvents()
    setPiCapabilities(undefined)
    setPiBackendState({ status: "booting" })
    void import("./eventSocket").then(({ resetPiEventSocket }) => resetPiEventSocket())
    void initializePiBackend().then(() => {
      // A switch can arrive while an older bootstrap promise is still active.
      // Re-run against the newly selected server once that promise is released.
      if (getPiBackendState().status === "booting") void initializePiBackend()
    })
  })
}

function scheduleBackendRetry(): void {
  if (retryTimer || typeof window === "undefined") return
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retryAttempt++, 5))
  retryTimer = setTimeout(() => {
    retryTimer = null
    void initializePiBackend()
  }, delay)
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
