import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  createAgentSessionFromServices,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent"
import { RealPiSession } from "./real-session.ts"

describe("RealPiSession with the Pi SDK", () => {
  it("projects an offline faux-provider turn without user configuration", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-real-sdk-"))
    const { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } = await loadPiAiFromPinnedSdk()
    const faux = fauxProvider({ provider: "piui-faux", api: "piui-faux" })
    faux.setResponses([
      fauxAssistantMessage("offline answer"),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline failure" }),
    ])
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    })
    modelRuntime.registerNativeProvider(faux.provider)
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    })
    const resourceLoader = emptyResourceLoader()
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      sessionManager,
      sessionStartEvent,
    }) => {
      const services: AgentSessionServices = {
        cwd,
        agentDir: cwd,
        modelRuntime,
        settingsManager,
        resourceLoader,
        diagnostics: [],
      }
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: faux.getModel(),
          thinkingLevel: "off",
          noTools: "all",
        })),
        services,
        diagnostics: [],
      }
    }

    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(cwd, undefined, {
        agentDir: cwd,
        createRuntime,
        createSessionManager: runtimeCwd => SessionManager.inMemory(runtimeCwd),
      })
      await session.prompt("ping")

      assert.equal(faux.state.callCount, 1)
      assert.equal(session.getSessionFile(), undefined)
      assert.equal(session.getModel()?.provider, "piui-faux")
      assert.ok(session.getProjection().timeline.some(item => item.type === "user" && item.text === "ping"))
      const assistant = session.getProjection().timeline.find(item => item.type === "assistant")
      assert.ok(assistant?.content.some(block => block.type === "text" && block.text === "offline answer"))

      await session.prompt("fail offline")
      const failed = session.getProjection().timeline.filter(item => item.type === "assistant").at(-1)
      assert.equal(faux.state.callCount, 2)
      assert.equal(failed?.status, "error")
      assert.equal(failed?.stopReason, "error")
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

type ModelRuntimeOptions = NonNullable<Parameters<typeof ModelRuntime.create>[0]>
type NativeProvider = Parameters<ModelRuntime["registerNativeProvider"]>[0]

interface PiAiTestApi {
  InMemoryCredentialStore: new () => NonNullable<ModelRuntimeOptions["credentials"]>
  fauxAssistantMessage(text: string, options?: { stopReason?: string; errorMessage?: string }): unknown
  fauxProvider(options: { provider: string; api: string }): {
    provider: NativeProvider
    state: { callCount: number }
    setResponses(responses: unknown[]): void
    getModel(): ReturnType<ModelRuntime["getModel"]> & object
  }
}

async function loadPiAiFromPinnedSdk(): Promise<PiAiTestApi> {
  let piAiEntry: string
  try {
    piAiEntry = import.meta.resolve("@earendil-works/pi-ai")
  } catch {
    const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent")
    piAiEntry = new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", codingAgentEntry).href
  }
  return await import(piAiEntry) as unknown as PiAiTestApi
}

function emptyResourceLoader(): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() }
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "",
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}
