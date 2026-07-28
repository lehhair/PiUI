/**
 * List models for UI. Lazy-loads Pi ModelRuntime only when driver=pi.
 */
import { getDriverMode, type PiModelInfo } from "@piui/pi-worker"

const MOCK_MODELS: PiModelInfo[] = [
  {
    id: "mock",
    name: "Mock (no LLM)",
    api: "mock",
    provider: "mock",
    baseUrl: "",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  },
]

export async function listModelsForUi(
  driver = getDriverMode(),
  listPiModels?: () => Promise<PiModelInfo[]>,
): Promise<{
  driver: string
  models: PiModelInfo[]
  error?: string
}> {
  if (driver === "mock") {
    return { driver, models: MOCK_MODELS }
  }

  try {
    const available = listPiModels
      ? await listPiModels()
      : await (await import("./pi-worker-client.ts")).PiWorkerSession.listModels()
    const models = available
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
