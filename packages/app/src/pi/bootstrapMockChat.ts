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
  } catch {
    console.info("[PiUI] server not up — skip mock chat seed (run npm run dev:server)")
    return null
  }

  try {
    const res = await fetch(`${base}/api/v1/dev/mock-chat`, { method: "POST" })
    if (!res.ok) {
      console.warn("[PiUI] mock-chat failed", res.status)
      return null
    }
    const data = (await res.json()) as { snapshot: SessionSnapshotV1 }
    const sessionId = applySnapshotToUi(data.snapshot)
    const hash = `#/session/${sessionId}`
    if (!window.location.hash.includes(sessionId)) {
      window.location.hash = hash
    }
    console.info("[PiUI] mock chat seeded", sessionId)
    return sessionId
  } catch (err) {
    console.warn("[PiUI] mock chat seed error", err)
    return null
  }
}
