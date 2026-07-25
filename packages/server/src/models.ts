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

export async function listModelsForUi(driver = getDriverMode()): Promise<{
  driver: string
  models: ModelDtoV1[]
  error?: string
}> {
  if (driver === "mock") {
    return { driver, models: MOCK_MODELS }
  }

  try {
    const { PiWorkerSession } = await import("./pi-worker-client.ts")
    const available = await PiWorkerSession.listModels()
    const models: ModelDtoV1[] = available.map(m => {
      return {
        id: m.id,
        name: m.name || m.id,
        providerId: m.providerId,
        providerName: m.providerId,
        family: m.family,
        contextLimit: m.contextLimit,
        outputLimit: m.outputLimit,
        supportsReasoning: m.supportsReasoning,
        supportsImages: m.supportsImages,
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
        models: [],
        error: "no Pi models available - check ~/.pi/agent auth",
      }
    }
    return { driver, models }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      driver,
      models: [],
      error: msg,
    }
  }
}
