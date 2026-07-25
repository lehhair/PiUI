import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
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

      const nativeEntries = session.getEntries()
      const userEntry = nativeEntries.find(entry => entry.type === "message" && entry.role === "user")
      const assistantEntry = nativeEntries.find(entry => entry.type === "message" && entry.role === "assistant")
      assert.ok(userEntry)
      assert.ok(assistantEntry)
      session.setLabel(assistantEntry.id, "offline checkpoint")
      session.setSessionName("Offline R3")
      assert.equal(session.getSessionName(), "Offline R3")
      assert.equal(findTreeLabel(session.getTree(), assistantEntry.id), "offline checkpoint")

      const navigation = await session.navigateTree(userEntry.id)
      assert.equal(navigation.editorText, "ping")
      const sourceSessionId = session.getSessionId()
      const replacement = await session.fork(assistantEntry.id, "at")
      assert.equal(replacement.sourceSessionId, sourceSessionId)
      assert.notEqual(replacement.targetSessionId, sourceSessionId)
      assert.equal(replacement.cancelled, false)

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

  it("stages imports under a unique filename before Pi can overwrite an existing session", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-real-import-"))
    const { fauxAssistantMessage } = await loadPiAiFromPinnedSdk()
    const sessionDir = path.join(cwd, "sessions")
    const inputDir = path.join(cwd, "inputs")
    mkdirSync(inputDir)
    const currentManager = SessionManager.create(cwd, sessionDir)
    currentManager.appendMessage({ role: "user", content: "source content", timestamp: Date.now() } as never)
    currentManager.appendMessage(fauxAssistantMessage("source answer") as never)
    const importedManager = SessionManager.create(cwd, inputDir)
    importedManager.appendMessage({ role: "user", content: "imported content", timestamp: Date.now() } as never)
    importedManager.appendMessage(fauxAssistantMessage("imported answer") as never)
    const sourceFile = currentManager.getSessionFile()!
    const importedFile = importedManager.getSessionFile()!
    const collidingInput = path.join(inputDir, path.basename(sourceFile))
    copyFileSync(importedFile, collidingInput)
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    })
    const settingsManager = SettingsManager.inMemory()
    const resourceLoader = emptyResourceLoader()
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
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
          noTools: "all",
        })),
        services,
        diagnostics: [],
      }
    }

    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(cwd, sourceFile, {
        agentDir: cwd,
        createRuntime,
        createSessionManager: () => currentManager,
      })
      const sourceBefore = readFileSync(sourceFile, "utf8")
      const sourceSessionId = session.getSessionId()
      await assert.rejects(
        session.importSession(path.join(inputDir, "missing.jsonl"), cwd),
        { name: "SessionImportFileNotFoundError" },
      )
      assert.equal(session.getSessionId(), sourceSessionId)
      assert.equal(readFileSync(sourceFile, "utf8"), sourceBefore)

      const replacement = await session.importSession(collidingInput, cwd)
      assert.equal(replacement.cancelled, false)
      assert.notEqual(path.resolve(replacement.targetSessionFile!), path.resolve(sourceFile))
      assert.equal(readFileSync(sourceFile, "utf8"), sourceBefore)
      assert.match(path.basename(replacement.targetSessionFile!), /^piui-import-.*\.jsonl$/)
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

function findTreeLabel(
  roots: ReturnType<RealPiSession["getTree"]>,
  entryId: string,
): string | undefined {
  const stack = [...roots]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.entry.id === entryId) return node.label
    stack.push(...node.children)
  }
  return undefined
}

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
