import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
import { PiCatalog } from "./catalog.ts"
import { loadPiSdk } from "../sdk-host.ts"

await loadPiSdk()

type AnyRecord = Record<string, any>

function allEntries(session: RealPiSession): AnyRecord[] {
  return session.getEntriesPage(undefined, 100_000, 256 * 1024 * 1024).items as AnyRecord[]
}

function activeBranchEntries(session: RealPiSession): AnyRecord[] {
  return session.getBranchPage(undefined, 100_000, 256 * 1024 * 1024).items as AnyRecord[]
}

function sessionTree(session: RealPiSession): AnyRecord[] {
  return session.getTree() as AnyRecord[]
}

describe("RealPiSession with the Pi SDK", () => {
  it("uses the configured sessionDir for creation and discovery", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-session-dir-"))
    const cwd = path.join(root, "workspace")
    const agentDir = path.join(root, "agent")
    const sessionDir = path.join(root, "sessions")
    mkdirSync(cwd)
    mkdirSync(agentDir)
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir }))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(cwd, undefined, { agentDir })
      assert.equal(path.dirname(session.getSessionFile()!), sessionDir)
      const discoverable = SessionManager.create(cwd, sessionDir)
      discoverable.appendMessage({ role: "user", content: "persist", timestamp: Date.now() })
      const { fauxAssistantMessage } = await loadPiAiFromPinnedSdk()
      discoverable.appendMessage(fauxAssistantMessage("persisted"))
      assert.equal(existsSync(discoverable.getSessionFile()!), true)
      assert.equal((await SessionManager.list(cwd, sessionDir)).some(item => item.id === discoverable.getSessionId()), true)
      const catalog = new PiCatalog(agentDir)
      assert.equal(((await catalog.listSessions(cwd)) as AnyRecord[]).some(item => item.id === discoverable.getSessionId()), true)
      assert.equal(SettingsManager.create(process.cwd(), agentDir).getSessionDir(), sessionDir)
      assert.equal(((await catalog.listAllSessions()) as AnyRecord[]).some(item => item.id === discoverable.getSessionId()), true)
      await session.dispose()
      session = await RealPiSession.open(cwd, discoverable.getSessionFile(), { agentDir })
      const replacement = await session.newSession()
      assert.equal(path.dirname(replacement.targetSessionFile!), sessionDir)
    } finally {
      await session?.dispose()
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("prefers the Pi session directory environment override", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-session-dir-env-"))
    const cwd = path.join(root, "workspace")
    const agentDir = path.join(root, "agent")
    const sessionDir = path.join(root, "environment-sessions")
    mkdirSync(cwd)
    mkdirSync(agentDir)
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: path.join(root, "settings-sessions") }))
    const previous = process.env.PI_CODING_AGENT_SESSION_DIR
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(cwd, undefined, { agentDir })
      assert.equal(path.dirname(session.getSessionFile()!), sessionDir)
    } finally {
      await session?.dispose()
      if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = previous
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("validates and persists every extended settings value", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-settings-"))
    const cwd = path.join(root, "workspace")
    const agentDir = path.join(root, "agent")
    mkdirSync(cwd)
    mkdirSync(agentDir)
    const previousHttpProxy = process.env.HTTP_PROXY
    const previousHttpsProxy = process.env.HTTPS_PROXY
    try {
      const catalog = new PiCatalog(agentDir)
      const result = await catalog.patchSettings(cwd, {
        defaultThinkingLevel: "max",
        transport: "websocket-cached",
        httpIdleTimeoutMs: 1234,
        httpProxy: " http://127.0.0.1:7890 ",
        shellPath: null,
        packages: [
          "npm:plain-package",
          { source: "git:filtered-package", autoload: false, extensions: ["index.ts"] },
        ],
        warnings: { anthropicExtraUsage: false },
      }) as AnyRecord
      assert.equal(result.effective.defaultThinkingLevel, "max")
      assert.equal(result.effective.transport, "websocket-cached")
      assert.equal(result.effective.httpIdleTimeoutMs, 1234)
      assert.equal(result.effective.httpProxy, "http://127.0.0.1:7890")
      assert.deepEqual(result.effective.packages, [
        "npm:plain-package",
        { source: "git:filtered-package", autoload: false, extensions: ["index.ts"] },
      ])

      await assert.rejects(
        catalog.patchSettings(cwd, { packages: [{ source: "x", unknown: true }] }),
        /invalid Pi setting: packages/,
      )
      await assert.rejects(
        catalog.patchSettings(cwd, { warnings: { anthropicExtraUsage: "yes" as never } }),
        /invalid Pi setting: warnings/,
      )
      await assert.rejects(
        catalog.patchSettings(cwd, { httpIdleTimeoutMs: -1 }),
        /invalid Pi setting: httpIdleTimeoutMs/,
      )
      await assert.rejects(
        catalog.patchSettings(cwd, { httpProxy: 42 as never }),
        /invalid Pi setting: httpProxy/,
      )
      const cleared = await catalog.patchSettings(cwd, { httpProxy: null }) as AnyRecord
      assert.equal(cleared.effective.httpProxy, undefined)
    } finally {
      if (previousHttpProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = previousHttpProxy
      if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = previousHttpsProxy
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("lets global extensions decide project trust before project resources load", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-project-trust-"))
    const cwd = path.join(root, "workspace")
    const agentDir = path.join(root, "agent")
    const projectExtensions = path.join(cwd, ".pi", "extensions")
    mkdirSync(projectExtensions, { recursive: true })
    mkdirSync(agentDir)
    const trustExtension = path.join(root, "trust-extension.js")
    writeFileSync(trustExtension, `
export default function (pi) {
  pi.on("project_trust", () => ({ trusted: "yes", remember: true }))
}
`)
    writeFileSync(path.join(projectExtensions, "trusted-command.js"), `
export default function (pi) {
  pi.registerCommand("trusted-project-command", { description: "trusted", handler: async () => {} })
}
`)
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: [trustExtension] }))
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(cwd, undefined, { agentDir })
      await session.initializeExtensions()
      assert.equal(session.getRegistry().commands.some(command => command.name === "trusted-project-command"), true)
      assert.equal(session.getRegistry().commands.some(command => command.name === "reload" && command.sourceInfo?.builtin === true), true)
      assert.equal(new (await import("@earendil-works/pi-coding-agent")).ProjectTrustStore(agentDir).get(cwd), true)
    } finally {
      await session?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("streams raw events and persists an offline faux-provider turn", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-real-sdk-"))
    const { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } = await loadPiAiFromPinnedSdk()
    const faux = fauxProvider({ provider: "piui-faux", api: "piui-faux" })
    faux.setResponses([
      fauxAssistantMessage("offline answer"),
      fauxAssistantMessage("idle reply"),
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
      const skippedCompaction = await session.compact()
      assert.equal(skippedCompaction.status, "skipped")
      const nativeEvents: Array<Record<string, unknown>> = []
      const unsubscribeNative = session.onPiEvent(
        event => nativeEvents.push(event as Record<string, unknown>),
      )
      await session.prompt("ping", [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }])
      unsubscribeNative()

      // The authenticated client receives Pi's complete JSON event structure.
      assert.ok(nativeEvents.length > 0)
      for (const event of nativeEvents) {
        assert.equal(typeof event.type, "string")
      }
      assert.ok(nativeEvents.some(event => {
        const message = event.message
        return event.type === "message_start" && message && typeof message === "object" &&
          !Array.isArray(message) && (message as { role?: unknown }).role === "user"
      }))

      assert.equal(faux.state.callCount, 1)
      assert.equal(session.getSessionFile(), undefined)
      assert.equal((session.getState().model as AnyRecord)?.provider, "piui-faux")
      const nativeEntries = allEntries(session)
      const userEntry = nativeEntries.find(entry => entry.type === "message" && nativeRole(entry) === "user")
      const assistantEntry = nativeEntries.find(entry => entry.type === "message" && nativeRole(entry) === "assistant")
      assert.ok(userEntry)
      assert.ok(assistantEntry)
      assert.deepEqual(
        session.getBranchPage(undefined, 100, 32 * 1024 * 1024).items,
        activeBranchEntries(session),
      )
      const userMessage = userEntry.message
      assert.ok(userMessage && typeof userMessage === "object" && !Array.isArray(userMessage))
      assert.deepEqual(userMessage.content, [
        { type: "text", text: "ping" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ])
      await session.setLabel(String(assistantEntry.id), "offline checkpoint")
      await session.setSessionName("Offline R3")
      assert.equal(session.getState().sessionName, "Offline R3")
      assert.equal(findTreeLabel(sessionTree(session), String(assistantEntry.id)), "offline checkpoint")
      assert.deepEqual(findTreeNode(sessionTree(session), String(assistantEntry.id))?.entry, assistantEntry)
      await assert.rejects(
        session.setActiveTools(["piui-tool-that-does-not-exist"]),
        error => (error as { code?: string }).code === "INVALID_REQUEST",
      )

      const navigation = await session.navigateTree(String(userEntry.id))
      assert.equal(navigation.editorText, "ping")
      const sourceSessionId = session.getSessionId()
      const replacement = await session.fork(assistantEntry.id, "at")
      assert.equal(replacement.sourceSessionId, sourceSessionId)
      assert.notEqual(replacement.targetSessionId, sourceSessionId)
      assert.equal(replacement.cancelled, false)

      const uiState = session.getState()
      assert.equal(uiState.isBashRunning, false)
      assert.equal(uiState.hasPendingBashMessages, false)
      assert.equal(uiState.isRetrying, false)
      assert.equal(uiState.retryAttempt, 0)
      assert.equal(uiState.pendingMessageCount, 0)
      await assert.rejects(
        session.cycleThinkingLevel(),
        error => (error as { code?: string }).code === "CAPABILITY_DISABLED",
      )

      await session.sendUserMessage("sent while idle")
      assert.equal(faux.state.callCount, 2)
      assert.ok(allEntries(session).some(entry =>
        entry.type === "message" && nativeRole(entry) === "user" && nativeMessageText(entry) === "sent while idle"
      ))

      await session.prompt("fail offline")
      const failed = allEntries(session).filter(entry =>
        entry.type === "message" && nativeRole(entry) === "assistant"
      ).at(-1)
      assert.equal(faux.state.callCount, 3)
      assert.equal(nativeMessage(failed).stopReason, "error")
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
        { code: "NOT_FOUND" },
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

  it("keeps a live checkpoint while an extension settles message_end", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-real-live-settlement-"))
    let session: RealPiSession | undefined
    let release!: () => void
    try {
      const opened = await openOfflineSession(cwd, {
        provider: "piui-faux-live-settlement",
        api: "piui-faux-live-settlement",
        models: [{ id: "live-1", contextWindow: 4096, maxTokens: 256 }],
      }, {
        compaction: { enabled: false },
        retry: { enabled: false },
      }, api => [api.fauxAssistantMessage("settled answer")])
      session = opened.session
      await session.initializeExtensions()

      const runner = (session as unknown as {
        runtime: { session: { _extensionRunner?: { emitMessageEnd: (event: unknown) => Promise<unknown> } } }
      }).runtime.session._extensionRunner
      assert.ok(runner)
      const originalEmitMessageEnd = runner.emitMessageEnd.bind(runner)
      let markBlocked!: () => void
      const blocked = new Promise<void>(resolve => { markBlocked = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      runner.emitMessageEnd = async event => {
        const message = event && typeof event === "object" && "message" in event
          ? (event as { message?: { role?: unknown } }).message
          : undefined
        if (message?.role === "user") {
          markBlocked()
          await gate
        }
        return originalEmitMessageEnd(event)
      }

      const prompt = session.prompt("hold user settlement")
      await blocked
      const during = session.getBranchPage(undefined, 100, 32 * 1024 * 1024)
      assert.equal(during.items.some(entry => nativeRole(entry) === "user"), false)
      assert.equal(during.checkpoint?.liveMessage?.phase, "streaming")
      const live = during.checkpoint?.liveMessage?.message
      assert.ok(live && typeof live === "object" && !Array.isArray(live))
      assert.equal(live.role, "user")

      release()
      await prompt
      const settled = session.getBranchPage(undefined, 100, 32 * 1024 * 1024)
      assert.equal(settled.checkpoint?.liveMessage, undefined)
      assert.ok(settled.items.some(entry => nativeRole(entry) === "user"))
      assert.ok(settled.items.some(entry => nativeRole(entry) === "assistant"))
      const latest = session.getBranchPage(undefined, 1, 32 * 1024 * 1024)
      assert.ok(latest.beforeCursor)
      assert.ok(latest.checkpoint)
      const older = session.getBranchPage(latest.beforeCursor, 1, 32 * 1024 * 1024)
      assert.equal(older.checkpoint, undefined)
      await session.sendCustomMessage("fixture.custom", [{ type: "text", text: "custom" }], { display: true })
      assert.equal(session.getBranchPage(undefined, 100, 32 * 1024 * 1024).checkpoint?.liveMessage, undefined)
    } finally {
      release?.()
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("samples the native streaming message while a message_start extension is blocked", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-real-live-start-"))
    let session: RealPiSession | undefined
    let release!: () => void
    try {
      const opened = await openOfflineSession(cwd, {
        provider: "piui-faux-live-start",
        api: "piui-faux-live-start",
        models: [{ id: "live-start-1", contextWindow: 4096, maxTokens: 256 }],
      }, {
        compaction: { enabled: false },
        retry: { enabled: false },
      }, api => [api.fauxAssistantMessage("answer")])
      session = opened.session
      await session.initializeExtensions()
      const runner = (session as unknown as {
        runtime: { session: { _extensionRunner?: { emit: (event: { type?: string }) => Promise<unknown> } } }
      }).runtime.session._extensionRunner
      assert.ok(runner)
      const originalEmit = runner.emit.bind(runner)
      let markBlocked!: () => void
      const blocked = new Promise<void>(resolve => { markBlocked = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      let held = false
      runner.emit = async event => {
        if (!held && event.type === "message_start") {
          held = true
          markBlocked()
          await gate
        }
        return originalEmit(event)
      }
      const eventLiveIds: string[] = []
      const off = session.onPiEvent((event, meta) => {
        if (event && typeof event === "object" && !Array.isArray(event) && event.type === "message_start" && meta.liveMessage) {
          eventLiveIds.push(meta.liveMessage.id)
        }
      })

      const prompt = session.prompt("blocked start")
      await blocked
      const during = session.getBranchPage(undefined, 100, 32 * 1024 * 1024)
      const provisionalId = during.checkpoint?.liveMessage?.id
      assert.ok(provisionalId)
      const provisional = during.checkpoint?.liveMessage?.message
      assert.ok(provisional && typeof provisional === "object" && !Array.isArray(provisional))
      assert.equal(provisional.role, "user")

      release()
      await prompt
      off()
      assert.equal(eventLiveIds[0], provisionalId)
    } finally {
      release?.()
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("keeps the live id while a message_update extension is blocked", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-real-live-update-"))
    let session: RealPiSession | undefined
    let release!: () => void
    try {
      const answer = "streaming answer ".repeat(20)
      const opened = await openOfflineSession(cwd, {
        provider: "piui-faux-live-update",
        api: "piui-faux-live-update",
        models: [{ id: "live-update-1", contextWindow: 4096, maxTokens: 256 }],
        tokensPerSecond: 200,
        tokenSize: { min: 1, max: 1 },
      }, {
        compaction: { enabled: false },
        retry: { enabled: false },
      }, api => [api.fauxAssistantMessage(answer)])
      session = opened.session
      await session.initializeExtensions()
      const runner = (session as unknown as {
        runtime: { session: { _extensionRunner?: { emit: (event: { type?: string }) => Promise<unknown> } } }
      }).runtime.session._extensionRunner
      assert.ok(runner)
      const originalEmit = runner.emit.bind(runner)
      let markBlocked!: () => void
      const blocked = new Promise<void>(resolve => { markBlocked = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      let held = false
      runner.emit = async event => {
        if (!held && event.type === "message_update") {
          held = true
          markBlocked()
          await gate
        }
        return originalEmit(event)
      }
      let assistantStartId: string | undefined
      let assistantUpdateId: string | undefined
      const off = session.onPiEvent((event, meta) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) return
        const message = event.message
        if (!message || typeof message !== "object" || Array.isArray(message) || message.role !== "assistant") return
        if (event.type === "message_start") assistantStartId = meta.liveMessage?.id
        if (event.type === "message_update") assistantUpdateId = meta.liveMessage?.id
      })

      const prompt = session.prompt("blocked update")
      await blocked
      const during = session.getBranchPage(undefined, 100, 32 * 1024 * 1024)
      const provisionalId = during.checkpoint?.liveMessage?.id
      assert.ok(assistantStartId)
      assert.equal(provisionalId, assistantStartId)
      assert.ok((during.checkpoint?.liveMessage?.revision ?? 0) > 1)

      release()
      await prompt
      off()
      assert.equal(assistantUpdateId, assistantStartId)
    } finally {
      release?.()
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("keeps steer and follow-up in independent native queues during a streamed turn", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-real-control-"))
    const slowText = "streaming content ".repeat(12)
    let session: RealPiSession | undefined
    try {
      const opened = await openOfflineSession(cwd, {
        provider: "piui-faux-control",
        api: "piui-faux-control",
        models: [{ id: "control-1", contextWindow: 4096, maxTokens: 256 }],
        tokensPerSecond: 200,
        tokenSize: { min: 1, max: 1 },
      }, {
        compaction: { enabled: false },
        retry: { enabled: false },
        steeringMode: "all",
        followUpMode: "all",
      }, api => [
        api.fauxAssistantMessage(slowText),
        api.fauxAssistantMessage("steering handled"),
        api.fauxAssistantMessage("follow-up handled"),
      ])
      session = opened.session
      const nativeEvents: Array<Record<string, unknown>> = []
      let resolvePartial!: () => void
      const partialStarted = new Promise<void>(resolve => { resolvePartial = resolve })
      const offNative = session.onPiEvent(event => {
        if (!event || typeof event !== "object" || Array.isArray(event)) return
        nativeEvents.push(event)
        if (event.type !== "message_update") return
        const message = event.message
        if (!message || typeof message !== "object" || Array.isArray(message)) return
        const text = nativeContentText(message.content)
        return text.length > 0 && text.length < slowText.length
          ? resolvePartial()
          : undefined
      })

      const prompt = session.prompt("initial")
      await partialStarted
      const livePage = session.getBranchPage(undefined, 100, 32 * 1024 * 1024)
      const liveMessage = livePage.checkpoint?.liveMessage?.message
      assert.ok(liveMessage && typeof liveMessage === "object" && !Array.isArray(liveMessage))
      assert.equal(liveMessage.role, "assistant")
      assert.ok(nativeContentText(liveMessage.content).length > 0)
      assert.ok(nativeContentText(liveMessage.content).length < slowText.length)
      await session.steer("steer now")
      await session.followUp("follow up later")
      assert.deepEqual((session.getState().queue as AnyRecord).steering, ["steer now"])
      assert.deepEqual((session.getState().queue as AnyRecord).followUp, ["follow up later"])

      await prompt
      offNative()
      assert.equal(opened.faux.state.callCount, 3)
      assert.equal(opened.faux.getPendingResponseCount(), 0)
      assert.deepEqual((session.getState().queue as AnyRecord).steering, [])
      assert.deepEqual((session.getState().queue as AnyRecord).followUp, [])
      const answers = allEntries(session)
        .filter(entry => entry.type === "message" && nativeRole(entry) === "assistant")
        .map(nativeMessageText)
      assert.deepEqual(answers, [slowText, "steering handled", "follow-up handled"])
      assert.ok(nativeEvents.some(event => event.type === "message_update" && "message" in event))
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("reports native auto-retry phases and the final result", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-real-retry-"))
    let session: RealPiSession | undefined
    try {
      const opened = await openOfflineSession(cwd, {
        provider: "piui-faux-retry",
        api: "piui-faux-retry",
        models: [{ id: "retry-1", contextWindow: 4096, maxTokens: 256 }],
      }, {
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
      }, api => [
        api.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" }),
        api.fauxAssistantMessage("retry recovered"),
      ])
      session = opened.session
      const phases: string[] = []
      const off = session.onPiEvent(() => {
        const phase = String((session.getState().retry as AnyRecord).phase)
        if (phases.at(-1) !== phase) phases.push(phase)
      })
      await session.prompt("retry this")
      off()

      const waiting = phases.indexOf("waiting")
      const running = phases.indexOf("running")
      const finished = phases.indexOf("finished")
      assert.ok(waiting >= 0)
      assert.ok(running > waiting)
      assert.ok(finished > running)
      const retry = session.getState().retry as AnyRecord
      assert.equal(retry.phase, "finished")
      if (retry.phase !== "finished") assert.fail("retry did not finish")
      assert.equal(retry.success, true)
      assert.equal(retry.attempt, 1)
      assert.equal(opened.faux.state.callCount, 2)
      assert.equal(opened.faux.getPendingResponseCount(), 0)
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("returns and persists a native abandoned-branch summary", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-real-branch-summary-"))
    let session: RealPiSession | undefined
    try {
      const opened = await openOfflineSession(cwd, {
        provider: "piui-faux-branch-summary",
        api: "piui-faux-branch-summary",
        models: [{ id: "branch-1", contextWindow: 4096, maxTokens: 256 }],
      }, {
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
        branchSummary: { reserveTokens: 32 },
      }, api => [
        api.fauxAssistantMessage("first answer"),
        api.fauxAssistantMessage("second answer"),
        api.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" }),
        api.fauxAssistantMessage("abandoned branch summary"),
      ])
      session = opened.session
      const operationPhases: string[] = []
      const off = session.onPiEvent(() => {
        const operation = (session.getState().compaction as AnyRecord).operation as AnyRecord
        if (operation.type === "branchSummary" && operationPhases.at(-1) !== operation.phase) {
          operationPhases.push(operation.phase)
        }
      })
      await session.prompt("one")
      await session.prompt("two")
      const target = allEntries(session)
        .filter(entry => entry.type === "message" && nativeRole(entry) === "assistant")
        .at(0)
      assert.ok(target)

      const navigation = await session.navigateTree(String(target.id), {
        summarize: true,
        customInstructions: "Preserve the parser decision",
      })
      off()
      assert.equal(navigation.cancelled, false)
      assert.ok(!navigation.aborted)
      const summaryEntry = navigation.summaryEntry as AnyRecord | null
      assert.equal(summaryEntry?.type, "branch_summary")
      if (summaryEntry?.type !== "branch_summary") assert.fail("branch summary was not persisted")
      assert.match(String(summaryEntry.summary), /abandoned branch summary/)
      assert.ok(allEntries(session).some(entry => entry.type === "branch_summary"))
      assert.ok(operationPhases.includes("retrying"))
      assert.equal(opened.faux.state.callCount, 4)
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("returns and persists a manual compaction result with custom instructions", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-real-compact-"))
    let session: RealPiSession | undefined
    try {
      const opened = await openOfflineSession(cwd, {
        provider: "piui-faux-compact",
        api: "piui-faux-compact",
        models: [{ id: "compact-1", contextWindow: 4096, maxTokens: 256 }],
      }, {
        compaction: { enabled: false, reserveTokens: 32, keepRecentTokens: 1 },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
      }, api => [
        api.fauxAssistantMessage("first answer"),
        api.fauxAssistantMessage("second answer"),
        api.fauxAssistantMessage("history summary"),
        api.fauxAssistantMessage("turn prefix summary"),
      ])
      session = opened.session
      await session.prompt("one")
      await session.prompt("two")
      const lastAssistant = allEntries(session)
        .filter(entry => entry.type === "message" && nativeRole(entry) === "assistant")
        .at(-1)
      assert.ok(lastAssistant)

      const compacted = await session.compact("preserve test checkpoints") as AnyRecord
      assert.equal(compacted.status, "completed")
      if (compacted.status !== "completed") assert.fail("manual compaction was skipped")
      assert.match(compacted.result.summary, /history summary/)
      assert.match(compacted.result.summary, /turn prefix summary/)
      assert.equal(compacted.result.firstKeptEntryId, String(lastAssistant.id))
      assert.ok(compacted.result.tokensBefore > 0)
      assert.ok((compacted.result.estimatedTokensAfter ?? 0) > 0)
      assert.equal(opened.faux.state.callCount, 4)
      assert.equal(opened.faux.getPendingResponseCount(), 0)
      assert.ok(allEntries(session).some(entry => entry.type === "compaction"))
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

function findTreeLabel(
  roots: AnyRecord[],
  entryId: string,
): string | undefined {
  const node = findTreeNode(roots, entryId)
  return typeof node?.label === "string" ? node.label : undefined
}

function findTreeNode(
  roots: AnyRecord[],
  entryId: string,
): AnyRecord | undefined {
  const stack = [...roots]
  while (stack.length > 0) {
    const node = stack.pop()!
    const entry = node.entry
    if (entry && typeof entry === "object" && !Array.isArray(entry) && entry.id === entryId) {
      return node
    }
    if (Array.isArray(node.children)) {
      stack.push(...node.children.filter(
        (child): child is typeof node => Boolean(child) && typeof child === "object" && !Array.isArray(child),
      ))
    }
  }
  return undefined
}

function nativeRole(entry: AnyRecord): unknown {
  const message = entry.message
  return message && typeof message === "object" && !Array.isArray(message) ? message.role : undefined
}

function nativeMessage(entry: AnyRecord | undefined): Record<string, unknown> {
  const message = entry?.message
  return message && typeof message === "object" && !Array.isArray(message) ? message : {}
}

function nativeMessageText(entry: AnyRecord): string {
  return nativeContentText(nativeMessage(entry).content)
}

function nativeContentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap(block =>
    block && typeof block === "object" && !Array.isArray(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : []
  ).join("")
}

type ModelRuntimeOptions = NonNullable<Parameters<typeof ModelRuntime.create>[0]>
type NativeProvider = Parameters<ModelRuntime["registerNativeProvider"]>[0]

interface PiAiTestApi {
  InMemoryCredentialStore: new () => NonNullable<ModelRuntimeOptions["credentials"]>
  fauxAssistantMessage(text: string, options?: { stopReason?: string; errorMessage?: string }): unknown
  fauxProvider(options: {
    provider: string
    api: string
    models?: Array<{ id: string; contextWindow?: number; maxTokens?: number }>
    tokensPerSecond?: number
    tokenSize?: { min?: number; max?: number }
  }): {
    provider: NativeProvider
    state: { callCount: number }
    setResponses(responses: unknown[]): void
    getModel(): ReturnType<ModelRuntime["getModel"]> & object
    getPendingResponseCount(): number
  }
}

async function openOfflineSession(
  cwd: string,
  fauxOptions: Parameters<PiAiTestApi["fauxProvider"]>[0],
  settings: Parameters<typeof SettingsManager.inMemory>[0],
  responses: (api: PiAiTestApi) => unknown[],
): Promise<{
  session: RealPiSession
  faux: ReturnType<PiAiTestApi["fauxProvider"]>
}> {
  const api = await loadPiAiFromPinnedSdk()
  const faux = api.fauxProvider(fauxOptions)
  faux.setResponses(responses(api))
  const modelRuntime = await ModelRuntime.create({
    credentials: new api.InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  })
  modelRuntime.registerNativeProvider(faux.provider)
  await modelRuntime.refresh({ allowNetwork: false })
  const settingsManager = SettingsManager.inMemory(settings)
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
        model: faux.getModel(),
        thinkingLevel: "off",
        noTools: "all",
      })),
      services,
      diagnostics: [],
    }
  }
  return {
    session: await RealPiSession.open(cwd, undefined, {
      agentDir: cwd,
      createRuntime,
      createSessionManager: runtimeCwd => SessionManager.inMemory(runtimeCwd),
    }),
    faux,
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
