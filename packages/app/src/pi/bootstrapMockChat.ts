/**
 * Dev bootstrap: load mock session from piui-server and show in Chat UI.
 * No LLM. Disabled with VITE_PIUI_MOCK=0.
 */
import { applySnapshotToUi } from "./applySnapshot"
import { getApiBase } from "./sessionApi"
import type { SessionSnapshotV1 } from "@piui/protocol"

export async function bootstrapMockChatIfEnabled(): Promise<string | null> {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env
  if (env?.VITE_PIUI_MOCK === "0") return null

  const base = getApiBase()
  try {
    const health = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(2000) })
    if (!health.ok) return null
    const { setPiServerReachable } = await import("./serverMode")
    // 必须先标 Pi 模式，再 disconnect，避免 SSE 又连上
    setPiServerReachable(true)
    const { disconnectSSE, reportPiConnectionState } = await import("../api/events")
    disconnectSSE()
    // 连接态交给 Pi WS（下面 ensurePiEventSocket）
    reportPiConnectionState("connecting")
    const body = (await health.json()) as { driver?: string }
    console.info("[PiUI] server up, driver=", body.driver ?? "unknown")
  } catch {
    console.info("[PiUI] server not up — run npm run dev:server or npm run dev:server:pi")
    return null
  }

  try {
    const { ensurePiEventSocket } = await import("./eventSocket")
    ensurePiEventSocket()

    // refresh models once server is known
    void import("../hooks/useModels").then(m => m.refreshModels?.()).catch(() => {})

    const health2 = await fetch(`${base}/api/v1/health`)
    const h = (await health2.json()) as { driver?: string }
    // real pi: open empty session; mock: seed demo chat
    if (h.driver === "pi") {
      const { createPiSession } = await import("./sessionApi")
      const { snapshot } = await createPiSession({ title: "New chat", seedMock: false })
      const sessionId = applySnapshotToUi(snapshot)
      window.dispatchEvent(new CustomEvent("piui:sessions-changed"))
      window.location.hash = `#/session/${sessionId}`
      console.info("[PiUI] real-pi session ready", sessionId)
      return sessionId
    }

    const res = await fetch(`${base}/api/v1/dev/mock-chat`, { method: "POST" })
    if (!res.ok) {
      console.warn("[PiUI] mock-chat failed", res.status)
      return null
    }
    const data = (await res.json()) as { snapshot: SessionSnapshotV1 }
    const sessionId = applySnapshotToUi(data.snapshot)
    window.dispatchEvent(new CustomEvent("piui:sessions-changed"))
    const hash = `#/session/${sessionId}`
    if (!window.location.hash.includes(sessionId)) {
      window.location.hash = hash
    }
    console.info("[PiUI] mock chat seeded", sessionId)
    return sessionId
  } catch (err) {
    console.warn("[PiUI] bootstrap error", err)
    return null
  }
}
