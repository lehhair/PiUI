/**
 * List models for UI. Lazy-loads Pi ModelRuntime only when driver=pi.
 */
import { getDriverMode } from "@piui/pi-worker"

export interface ModelDtoV1 {
  id: string
  name: string
  providerId: string
  providerName: string
  family: string
  contextLimit: number
  outputLimit: number
  supportsReasoning: boolean
  supportsImages: boolean
  supportsPdf: boolean
  supportsAudio: boolean
  supportsVideo: boolean
  supportsToolcall: boolean
  variants: string[]
}

const MOCK_MODELS: ModelDtoV1[] = [
  {
    id: "mock",
    name: "Mock (no LLM)",
    providerId: "mock",
    providerName: "Mock",
    family: "mock",
    contextLimit: 128000,
    outputLimit: 8192,
    supportsReasoning: true,
    supportsImages: false,
    supportsPdf: false,
    supportsAudio: false,
    supportsVideo: false,
    supportsToolcall: true,
    variants: [],
  },
]

export async function listModelsForUi(): Promise<{
  driver: string
  models: ModelDtoV1[]
  error?: string
}> {
  const driver = getDriverMode()
  if (driver === "mock") {
    return { driver, models: MOCK_MODELS }
  }

  try {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent")
    const runtime = await ModelRuntime.create({ allowModelNetwork: false })
    const available = await runtime.getAvailable()
    const models: ModelDtoV1[] = available.map(m => {
      const input = (m as { input?: string[] }).input
      const supportsImages = Array.isArray(input) ? input.includes("image") : false
      return {
        id: m.id,
        name: m.name || m.id,
        providerId: m.provider,
        providerName: m.provider,
        family: (m as { family?: string }).family || "",
        contextLimit: m.contextWindow ?? 0,
        outputLimit: m.maxTokens ?? 0,
        supportsReasoning: Boolean((m as { reasoning?: boolean }).reasoning),
        supportsImages,
        supportsPdf: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsToolcall: true,
        variants: [],
      }
    })
    if (models.length === 0) {
      return {
        driver,
        models: MOCK_MODELS,
        error: "no models available — check ~/.pi/agent auth",
      }
    }
    return { driver, models }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      driver,
      models: MOCK_MODELS,
      error: msg,
    }
  }
}
