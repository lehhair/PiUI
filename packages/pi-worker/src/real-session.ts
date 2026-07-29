import { constants, copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type {
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  ProjectTrustContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent"
import type { ImageInput, JsonObject, JsonValue, RegistrySnapshot } from "@piui/protocol"
import { isJsonObject, requireJsonValue } from "@piui/protocol"
import { getLoadedSdk } from "./sdk-host.js"
import { configuredSessionDir, resolveUserPath } from "./catalog.js"
import { ExtensionUiBridge } from "./extension-ui-bridge.js"
import {
  entriesPageFromEntries,
  imageAttachmentFromEntry,
  sessionHeadFromParts,
  type BranchCheckpoint,
  type EntriesPage,
  type LiveMessage,
  type SessionHead,
} from "./pagination.js"
import type { PiEventMeta, SessionRuntime, Unsubscribe } from "./runtime.js"

export interface ExtensionHostActions {
  reserveReplacement(request: {
    reservationId: string
    sourceSessionId: string
    operation: "new" | "fork" | "switch"
    targetSessionFile?: string
  }): Promise<void>
  commitReplacement(reservationId: string, replacement: JsonObject): Promise<void>
  abortReplacement(reservationId: string): Promise<void>
  requestShutdown(sessionId: string): void
}

export interface RealPiSessionOpenOptions {
  agentDir?: string
  createRuntime?: CreateAgentSessionRuntimeFactory
  createSessionManager?: (cwd: string, sessionFile?: string) => unknown
  hostActions?: ExtensionHostActions
}

interface LiveMessageCheckpoint {
  value: LiveMessage
  messageIdentity: unknown
  entriesBeforeEnd: number
  provisional: boolean
}

function unsupportedExtensionHostAction(action: string): never {
  throw Object.assign(new Error(`Extension command context ${action} requires a coordinated PiUI host`), {
    code: "CAPABILITY_DISABLED",
  })
}

function extensionBindings(
  uiContext: ExtensionUiBridge["context"],
  runtime: AgentSessionRuntime,
  navigateTree: RealPiSession["navigateTree"],
  reload: RealPiSession["reload"],
  hostActions?: ExtensionHostActions,
) {
  return {
    mode: "rpc" as const,
    uiContext,
    commandContextActions: {
      waitForIdle: () => runtime.session.waitForIdle(),
      newSession: (options?: Parameters<AgentSessionRuntime["newSession"]>[0]) =>
        runExtensionReplacement(runtime, hostActions, "new", undefined, () => runtime.newSession(options)),
      fork: (entryId: string, options?: Parameters<AgentSessionRuntime["fork"]>[1]) =>
        runExtensionReplacement(runtime, hostActions, "fork", undefined, () => runtime.fork(entryId, options)),
      navigateTree: async (entryId: string, options?: {
        summarize?: boolean
        customInstructions?: string
        replaceInstructions?: boolean
        label?: string
      }) => {
        const result = await navigateTree(entryId, options)
        return { cancelled: result.cancelled === true }
      },
      switchSession: (sessionPath: string, options?: Parameters<AgentSessionRuntime["switchSession"]>[1]) =>
        runExtensionReplacement(runtime, hostActions, "switch", sessionPath, () =>
          runtime.switchSession(sessionPath, options)),
      reload,
    },
    abortHandler: () => { void runtime.session.abort() },
    shutdownHandler: () => hostActions
      ? hostActions.requestShutdown(runtime.session.sessionManager.getSessionId())
      : unsupportedExtensionHostAction("shutdown"),
    onError: (error: { extensionPath: string; event: string; error: string }) => {
      console.error(`[piui-worker] extension error (${error.event}) ${error.extensionPath}: ${error.error}`)
    },
  }
}

async function runExtensionReplacement(
  runtime: AgentSessionRuntime,
  hostActions: ExtensionHostActions | undefined,
  operation: "new" | "fork" | "switch",
  targetSessionFile: string | undefined,
  replace: () => Promise<{ cancelled: boolean }>,
): Promise<{ cancelled: boolean }> {
  if (!hostActions) return unsupportedExtensionHostAction(operation)
  const sourceSessionId = runtime.session.sessionManager.getSessionId()
  const reservationId = randomUUID()
  await hostActions.reserveReplacement({ reservationId, sourceSessionId, operation, targetSessionFile })
  try {
    const result = await replace()
    if (result.cancelled) {
      await hostActions.abortReplacement(reservationId)
      return result
    }
    const replacement: JsonObject = {
      operation,
      sourceSessionId,
      targetSessionId: runtime.session.sessionManager.getSessionId(),
      targetSessionFile: runtime.session.sessionManager.getSessionFile() ?? null,
      targetCwd: runtime.session.sessionManager.getCwd(),
      cancelled: false,
    }
    await hostActions.commitReplacement(reservationId, replacement)
    return result
  } catch (error) {
    await hostActions.abortReplacement(reservationId).catch(() => undefined)
    throw error
  }
}

const createDefaultRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
}) => {
  const {
    SettingsManager,
    applyHttpProxySettings,
    createAgentSessionServices,
    createAgentSessionFromServices,
    ProjectTrustStore,
    resolveProjectTrusted,
  } = getLoadedSdk().sdk
  const globalSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
  applyHttpProxySettings(globalSettings.getHttpProxy())
  const trustDiagnostics: string[] = []
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderReloadOptions: {
      resolveProjectTrust: ({ extensionsResult }) => resolveProjectTrusted({
        cwd,
        trustStore: new ProjectTrustStore(agentDir),
        extensionsResult,
        defaultProjectTrust: globalSettings.getDefaultProjectTrust(),
        projectTrustContext: projectTrustContextForRpc(cwd),
        onExtensionError: message => trustDiagnostics.push(message),
      }),
    },
  })
  services.diagnostics.push(...trustDiagnostics.map(message => ({ type: "warning" as const, message })))
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  }
}

function projectTrustContextForRpc(cwd: string): ProjectTrustContext {
  return {
    cwd,
    mode: "rpc",
    hasUI: false,
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
    },
  }
}

export class RealPiSession implements SessionRuntime {
  private runtime: AgentSessionRuntime
  private readonly extensionUi: ExtensionUiBridge
  private extensionsInitialized = false
  private sessionUnsub: (() => void) | null = null
  private readonly piEventListeners = new Set<(event: JsonObject, meta: PiEventMeta) => void>()
  private readonly headListeners = new Set<(head: SessionHead) => void>()
  private readonly resourceListeners = new Set<() => void>()
  private nativeRevision = 1
  private nativeFingerprint = ""
  private eventEpoch = randomUUID()
  private eventSequence = 0
  private liveMessage?: LiveMessageCheckpoint
  private isCompactingFlag = false
  private retryShadow: JsonObject = { phase: "idle" }
  private compactionShadow: JsonObject = { autoEnabled: true, operation: { type: "none" } }

  private constructor(runtime: AgentSessionRuntime, private readonly hostActions?: ExtensionHostActions) {
    this.runtime = runtime
    this.extensionUi = new ExtensionUiBridge(
      () => this.runtime.session.sessionManager.getSessionId(),
      () => undefined,
      () => this.runtime.session.resourceLoader.getThemes().themes.flatMap(theme =>
        theme.name ? [{ name: theme.name, path: theme.sourcePath }] : []),
    )
    this.nativeFingerprint = this.getNativeFingerprint()
    this.bindSessionEvents()
  }

  static async open(
    cwd: string,
    sessionFile?: string,
    options: RealPiSessionOpenOptions = {},
  ): Promise<RealPiSession> {
    const { SessionManager, createAgentSessionRuntime, getAgentDir } = getLoadedSdk().sdk
    if (sessionFile && !existsSync(sessionFile)) {
      throw Object.assign(new Error("Pi session file no longer exists"), { code: "SESSION_NOT_FOUND" })
    }
    const agentDir = options.agentDir ?? getAgentDir()
    const sessionDir = configuredSessionDir(cwd, agentDir)
    const sessionManager = (options.createSessionManager?.(cwd, sessionFile) ??
      (sessionFile
        ? sessionDir ? SessionManager.open(sessionFile, sessionDir) : SessionManager.open(sessionFile)
        : SessionManager.create(cwd, sessionDir))) as SessionManager
    if (sessionFile && pathKey(sessionManager.getCwd()) !== pathKey(cwd)) {
      throw Object.assign(new Error("Pi session workspace does not match the selected workspace"), {
        code: "SESSION_IDENTITY_MISMATCH",
      })
    }
    const runtime = await createAgentSessionRuntime(options.createRuntime ?? createDefaultRuntime, {
      cwd: sessionManager.getCwd(),
      agentDir,
      sessionManager,
    })

    const result = new RealPiSession(runtime, options.hostActions)
    runtime.setBeforeSessionInvalidate(() => result.detachSessionSubscriptions())
    runtime.setRebindSession(async session => {
      result.extensionUi.cancelAll("session_replaced")
      result.resetSessionShadowState()
      result.nativeRevision += 1
      result.nativeFingerprint = result.getNativeFingerprint()
      if (result.extensionsInitialized) {
        await session.bindExtensions(extensionBindings(
          result.extensionUi.context,
          result.runtime,
          result.navigateTree.bind(result),
          result.reload.bind(result),
          result.hostActions,
        ))
      }
      result.bindSessionEvents()
    })
    return result
  }

  async initializeExtensions(): Promise<void> {
    if (this.extensionsInitialized) return
    await this.runtime.session.bindExtensions(extensionBindings(
      this.extensionUi.context,
      this.runtime,
      this.navigateTree.bind(this),
      this.reload.bind(this),
      this.hostActions,
    ))
    this.extensionsInitialized = true
  }

  private bindSessionEvents(): void {
    this.sessionUnsub?.()
    this.sessionUnsub = this.runtime.session.subscribe(event => {
      const nativeEvent = toJsonObject(event)
      this.trackShadowState(event)
      const meta = this.captureEvent(event, nativeEvent)
      for (const listener of this.piEventListeners) listener(nativeEvent, meta)
      this.emitHeadIfChanged()
      if (event.type === "message_end" || event.type === "agent_settled" || event.type === "entry_appended") {
        queueMicrotask(() => {
          this.clearPersistedLiveMessage()
          this.emitHeadIfChanged()
        })
      }
    })
  }

  private trackShadowState(event: { type: string; [key: string]: unknown }): void {
    const session = this.runtime.session
    if (event.type === "compaction_start") {
      this.isCompactingFlag = true
      this.compactionShadow = {
        autoEnabled: session.autoCompactionEnabled,
        operation: {
          type: "compaction", phase: "running", reason: toJson(event.reason) ?? null,
        },
        lastAborted: null, lastError: null, lastNotice: null,
      }
    } else if (event.type === "compaction_end") {
      this.isCompactingFlag = false
      this.compactionShadow = {
        ...this.compactionShadow,
        autoEnabled: session.autoCompactionEnabled,
        operation: { type: "none" },
        lastResult: toJson(event.result) ?? this.compactionShadow.lastResult ?? null,
        lastAborted: Boolean(event.aborted),
        lastError: toJson(event.errorMessage) ?? null,
      }
    } else if (event.type === "auto_retry_start") {
      this.retryShadow = {
        phase: "waiting",
        autoEnabled: session.autoRetryEnabled,
        attempt: Number(event.attempt),
        maxAttempts: Number(event.maxAttempts),
        delayMs: Number(event.delayMs),
        nextAttemptAt: new Date(Date.now() + Number(event.delayMs)).toISOString(),
        errorMessage: toJson(event.errorMessage) ?? null,
      }
    } else if (event.type === "agent_start" && this.retryShadow.phase === "waiting") {
      this.retryShadow = {
        phase: "running",
        autoEnabled: session.autoRetryEnabled,
        attempt: this.retryShadow.attempt ?? 0,
        maxAttempts: this.retryShadow.maxAttempts ?? 0,
      }
    } else if (event.type === "agent_start" && this.retryShadow.phase === "finished") {
      this.retryShadow = { phase: "idle", autoEnabled: session.autoRetryEnabled }
    } else if (event.type === "auto_retry_end") {
      this.retryShadow = {
        phase: "finished",
        autoEnabled: session.autoRetryEnabled,
        success: Boolean(event.success),
        attempt: Number(event.attempt),
        finalError: toJson(event.finalError) ?? null,
      }
    } else if (event.type === "summarization_retry_scheduled") {
      const operation = isJsonObject(this.compactionShadow.operation) ? this.compactionShadow.operation : undefined
      if (operation && operation.type !== "none") {
        this.compactionShadow = {
          ...this.compactionShadow,
          operation: {
            ...operation,
            phase: "retrying",
            attempt: Number(event.attempt),
            maxAttempts: Number(event.maxAttempts),
            delayMs: Number(event.delayMs),
            errorMessage: toJson(event.errorMessage) ?? null,
          },
        }
      }
    } else if (event.type === "summarization_retry_attempt_start") {
      const operation = isJsonObject(this.compactionShadow.operation) ? this.compactionShadow.operation : undefined
      if (operation && operation.type !== "none") {
        this.compactionShadow = {
          ...this.compactionShadow,
          operation: { ...operation, phase: "running" },
        }
      }
    }
  }

  private captureEvent(
    event: { type: string; message?: unknown },
    nativeEvent: JsonObject,
  ): PiEventMeta {
    const position = { epoch: this.eventEpoch, sequence: ++this.eventSequence }
    const nativeMessage = isJsonObject(nativeEvent.message) ? nativeEvent.message : undefined
    const nativeRole = nativeMessage?.role
    const current = this.liveMessage
    const trackedMessage = nativeRole === "user" || nativeRole === "assistant" || nativeRole === "toolResult"
    if (trackedMessage && (event.type === "message_start" || event.type === "message_update" || event.type === "message_end")) {
      const isStart = event.type === "message_start"
      const currentMessage = current && isJsonObject(current.value.message) ? current.value.message : undefined
      const currentRole = currentMessage?.role
      const reusedCheckpoint = current && currentRole === nativeRole && current.value.phase === "streaming" &&
        (current.provisional || !isStart)
      this.liveMessage = {
        value: {
          id: reusedCheckpoint ? current.value.id : randomUUID(),
          revision: reusedCheckpoint ? current.value.revision + 1 : 1,
          phase: event.type === "message_end" ? "persisting" : "streaming",
          message: nativeMessage ?? null,
        },
        messageIdentity: event.message,
        entriesBeforeEnd: event.type === "message_end"
          ? this.runtime.session.sessionManager.getEntries().length
          : current?.entriesBeforeEnd ?? this.runtime.session.sessionManager.getEntries().length,
        provisional: false,
      }
    }
    return {
      ...position,
      liveMessage: this.liveMessage
        ? { id: this.liveMessage.value.id, revision: this.liveMessage.value.revision }
        : undefined,
    }
  }

  private syncLiveMessageFromAgentState(): void {
    const messageIdentity = this.runtime.session.agent.state.streamingMessage
    const message = toJson(messageIdentity)
    const role = isJsonObject(message) ? message.role : undefined
    if (!messageIdentity || !isJsonObject(message) ||
      (role !== "user" && role !== "assistant" && role !== "toolResult")) return
    const current = this.liveMessage
    if (current?.value.phase === "persisting") return
    const currentMessage = current && isJsonObject(current.value.message) ? current.value.message : undefined
    const currentRole = currentMessage?.role
    const reusedCheckpoint = current && currentRole === role && current.value.phase === "streaming" ? current : undefined
    if (reusedCheckpoint && JSON.stringify(reusedCheckpoint.value.message) === JSON.stringify(message)) return
    this.liveMessage = {
      value: {
        id: reusedCheckpoint?.value.id ?? randomUUID(),
        revision: reusedCheckpoint ? reusedCheckpoint.value.revision + 1 : 1,
        phase: "streaming",
        message,
      },
      messageIdentity,
      entriesBeforeEnd: this.runtime.session.sessionManager.getEntries().length,
      provisional: true,
    }
  }

  private clearPersistedLiveMessage(): void {
    const checkpoint = this.liveMessage
    if (!checkpoint || checkpoint.value.phase !== "persisting") return
    const persisted = this.runtime.session.sessionManager.getEntries()
      .slice(checkpoint.entriesBeforeEnd)
      .some(entry => entry.type === "message" && entry.message === checkpoint.messageIdentity)
    if (persisted && this.liveMessage?.value.id === checkpoint.value.id) this.liveMessage = undefined
  }

  private detachSessionSubscriptions(): void {
    this.sessionUnsub?.()
    this.sessionUnsub = null
  }

  private resetSessionShadowState(): void {
    this.isCompactingFlag = false
    this.retryShadow = { phase: "idle", autoEnabled: this.runtime.session.autoRetryEnabled }
    this.compactionShadow = {
      autoEnabled: this.runtime.session.autoCompactionEnabled,
      operation: { type: "none" },
    }
    this.eventEpoch = randomUUID()
    this.eventSequence = 0
    this.liveMessage = undefined
  }

  getSessionId(): string {
    return this.runtime.session.sessionId
  }

  getSessionFile(): string | undefined {
    return this.runtime.session.sessionFile
  }

  getCwd(): string {
    return this.runtime.session.sessionManager.getCwd()
  }

  getModelRuntime() {
    return this.runtime.session.modelRuntime
  }

  onPiEvent(listener: (event: JsonObject, meta: PiEventMeta) => void): Unsubscribe {
    this.piEventListeners.add(listener)
    return () => this.piEventListeners.delete(listener)
  }

  onHead(listener: (head: SessionHead) => void): Unsubscribe {
    this.headListeners.add(listener)
    return () => this.headListeners.delete(listener)
  }

  onExtensionUi(listener: (event: JsonObject) => void): Unsubscribe {
    return this.extensionUi.onEvent(listener as never)
  }

  onResourcesChanged(listener: () => void): Unsubscribe {
    this.resourceListeners.add(listener)
    return () => this.resourceListeners.delete(listener)
  }

  respondExtensionUi(requestId: string, response: JsonObject): Promise<boolean> {
    return Promise.resolve(this.extensionUi.respond(requestId, response as never))
  }

  async setExtensionEditorState(text: string): Promise<void> {
    this.extensionUi.setEditorState(text)
  }

  getHead(): SessionHead {
    const manager = this.runtime.session.sessionManager
    const header = toJson(manager.getHeader()) ?? null
    const version = isJsonObject(header) && typeof header.version === "number" ? header.version : undefined
    return sessionHeadFromParts({
      sdkVersion: getLoadedSdk().version,
      revision: this.nativeRevision,
      sessionFormatVersion: version,
      header: isJsonObject(header) ? header : null,
      leafId: manager.getLeafId(),
      entryCount: manager.getEntries().length,
    }, manager.getSessionId())
  }

  getEntriesPage(cursor: string | undefined, limit: number, maxBytes: number): EntriesPage {
    const manager = this.runtime.session.sessionManager
    return entriesPageFromEntries(this.getHead(), manager.getEntries(), { cursor, limit, maxBytes }, toJsonObject)
  }

  getBranchPage(cursor: string | undefined, limit: number, maxBytes: number): EntriesPage {
    const manager = this.runtime.session.sessionManager
    this.syncLiveMessageFromAgentState()
    this.clearPersistedLiveMessage()
    const checkpoint: BranchCheckpoint | undefined = cursor ? undefined : {
      position: { epoch: this.eventEpoch, sequence: this.eventSequence },
      liveMessage: this.liveMessage?.value,
    }
    return entriesPageFromEntries(this.getHead(), manager.getBranch(), { cursor, limit, maxBytes, checkpoint }, toJsonObject)
  }

  getTree(): JsonValue {
    const tree = toJson(this.runtime.session.sessionManager.getTree())
    if (!Array.isArray(tree) || tree.some(node => !isJsonObject(node))) {
      throw Object.assign(new Error("Pi session tree nodes are not JSON objects"), { code: "NATIVE_DATA_NOT_JSON" })
    }
    return tree
  }

  getAttachment(entryId: string, blockIndex: number): JsonObject {
    const entry = this.runtime.session.sessionManager.getEntry(entryId)
    if (!entry) throw Object.assign(new Error("entry not found"), { code: "NOT_FOUND" })
    return imageAttachmentFromEntry(toJsonObject(entry), blockIndex)
  }

  getState(): JsonObject {
    const session = this.runtime.session
    const contextUsage = session.getContextUsage()
    const stats = session.getSessionStats()
    return requireJsonValue({
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? null,
      sessionName: session.sessionManager.getSessionName() ?? null,
      cwd: session.sessionManager.getCwd(),
      model: toJson(session.model) ?? null,
      thinkingLevel: String(session.thinkingLevel ?? "off"),
      isStreaming: Boolean(session.isStreaming),
      isCompacting: this.isCompactingFlag || Boolean(session.isCompacting),
      steeringMode: String(session.steeringMode),
      followUpMode: String(session.followUpMode),
      autoCompactionEnabled: Boolean(session.autoCompactionEnabled),
      autoRetryEnabled: Boolean(session.autoRetryEnabled),
      messageCount: session.sessionManager.getEntries().length,
      pendingMessageCount: Number(session.pendingMessageCount ?? 0),
      availableThinkingLevels: this.getAvailableThinkingLevels(),
      isIdle: Boolean(session.isIdle ?? !session.isStreaming),
      isBashRunning: Boolean(session.isBashRunning),
      hasPendingBashMessages: Boolean(session.hasPendingBashMessages),
      isRetrying: Boolean(session.isRetrying),
      retryAttempt: Number(session.retryAttempt ?? 0),
      queue: {
        steering: [...(session.getSteeringMessages?.() ?? [])].map(String),
        followUp: [...(session.getFollowUpMessages?.() ?? [])].map(String),
        steeringMode: String(session.steeringMode),
        followUpMode: String(session.followUpMode),
      },
      supportsThinking: Boolean(session.supportsThinking?.() ?? true),
      activeTools: session.getActiveToolNames?.() ?? [],
      scopedModels: toJson(session.scopedModels) ?? [],
      contextUsage: toJson(contextUsage) ?? null,
      sessionStats: toJson(stats) ?? null,
      retry: this.retryShadow,
      compaction: this.compactionShadow,
      head: this.getHead(),
    }) as JsonObject
  }

  getRegistry(): RegistrySnapshot {
    const session = this.runtime.session
    const loader = session.resourceLoader
    const extensions = loader.getExtensions()
    const eventHandlers = new Set<string>()
    const extensionDescriptors = extensions.extensions.map(extension => {
      for (const key of extension.handlers.keys()) eventHandlers.add(key)
      return {
        path: extension.path,
        hidden: extension.hidden,
        sourceInfo: toJson(extension.sourceInfo),
        tools: [...extension.tools.keys()],
        commands: [...extension.commands.keys()],
        handlers: [...extension.handlers.keys()],
      }
    })
    return {
      sdkVersion: getLoadedSdk().version,
      tools: requireJsonValue(session.getAllTools()) as RegistrySnapshot["tools"],
      activeTools: session.getActiveToolNames?.() ?? [],
      commands: requireJsonValue(session.getCommands()) as RegistrySnapshot["commands"],
      extensions: extensionDescriptors,
      eventHandlers: [...eventHandlers],
    }
  }

  async invokeTool(name: string, args?: JsonObject): Promise<JsonValue | undefined> {
    await this.runtime.session.waitForIdle()
    const runner = this.runtime.session.extensionRunner
    if (!runner) throw Object.assign(new Error("extensions are not initialized"), { code: "CAPABILITY_DISABLED" })
    const registered = runner.getAllRegisteredTools().find(tool => tool.definition.name === name)
    if (!registered) throw Object.assign(new Error(`tool not found: ${name}`), { code: "NOT_FOUND" })
    const result = await registered.definition.execute(randomUUID(), args ?? {}, undefined, undefined, runner.createContext())
    this.emitHeadIfChanged()
    return toJson(result)
  }

  async invokeCommand(name: string, args?: string): Promise<JsonValue | undefined> {
    const runner = this.runtime.session.extensionRunner
    if (!runner) throw Object.assign(new Error("extensions are not initialized"), { code: "CAPABILITY_DISABLED" })
    const command = runner.getCommand(name)
    if (!command) throw Object.assign(new Error(`command not found: ${name}`), { code: "NOT_FOUND" })
    await command.handler(args ?? "", runner.createCommandContext())
    this.emitHeadIfChanged()
    return undefined
  }

  private getNativeFingerprint(): string {
    const manager = this.runtime.session.sessionManager
    const entries = manager.getEntries()
    const last = entries.at(-1)
    return `${entries.length}:${manager.getLeafId() ?? ""}:${last?.id ?? ""}:${last?.timestamp ?? ""}`
  }

  private emitHeadIfChanged(): void {
    const fingerprint = this.getNativeFingerprint()
    if (fingerprint === this.nativeFingerprint) return
    this.nativeFingerprint = fingerprint
    this.nativeRevision += 1
    const head = this.getHead()
    for (const listener of this.headListeners) listener(head)
  }

  private getAvailableThinkingLevels(): string[] {
    try {
      const levels = this.runtime.session.getAvailableThinkingLevels?.() ?? []
      return levels.map(String)
    } catch {
      return ["off", "minimal", "low", "medium", "high"]
    }
  }

  private assertImageSupport(images: ImageInput[] | undefined): void {
    if (!images?.length) return
    const model = this.runtime.session.model as { input?: string[] } | undefined
    if (!model?.input?.includes("image")) {
      throw Object.assign(new Error("The selected Pi model does not support image input"), {
        code: "CAPABILITY_DISABLED",
      })
    }
  }

  async prompt(text: string, images?: ImageInput[], options: { expandPromptTemplates?: boolean } = {}): Promise<void> {
    try {
      this.assertImageSupport(images)
      await this.runtime.session.prompt(text, {
        images: images?.length ? images : undefined,
        expandPromptTemplates: options.expandPromptTemplates,
        source: "rpc",
      })
    } finally {
      this.emitHeadIfChanged()
    }
  }

  async steer(text: string, images?: ImageInput[]): Promise<void> {
    if (!this.runtime.session.isStreaming) {
      throw Object.assign(new Error("Cannot steer an idle Pi session"), { code: "SESSION_CONFLICT" })
    }
    this.assertImageSupport(images)
    await this.runtime.session.steer(text, images)
  }

  async followUp(text: string, images?: ImageInput[]): Promise<void> {
    if (!this.runtime.session.isStreaming) {
      throw Object.assign(new Error("Cannot queue a follow-up on an idle Pi session"), { code: "SESSION_CONFLICT" })
    }
    this.assertImageSupport(images)
    await this.runtime.session.followUp(text, images)
  }

  async sendUserMessage(
    text: string,
    images?: ImageInput[],
    deliverAs?: "steer" | "followUp",
  ): Promise<void> {
    this.assertImageSupport(images)
    const content = images?.length
      ? [{ type: "text" as const, text }, ...images]
      : text
    try {
      await this.runtime.session.sendUserMessage(content, deliverAs ? { deliverAs } : undefined)
    } finally {
      this.emitHeadIfChanged()
    }
  }

  async abort(): Promise<JsonValue | undefined> {
    const cleared = this.runtime.session.clearQueue()
    await this.runtime.session.abort()
    return toJson(cleared)
  }

  async newSession(parentSession?: string): Promise<JsonObject> {
    await this.runtime.session.waitForIdle()
    const sourceSessionId = this.getSessionId()
    const result = await this.runtime.newSession({ parentSession })
    if (!result.cancelled) this.emitHeadIfChanged()
    return {
      operation: "new",
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: this.getSessionFile() ?? null,
      targetCwd: this.getCwd(),
      cancelled: Boolean(result.cancelled),
    }
  }

  async switchSession(sessionPath: string, cwdOverride?: string): Promise<JsonObject> {
    await this.runtime.session.waitForIdle()
    const sourceSessionId = this.getSessionId()
    const result = await this.runtime.switchSession(resolveUserPath(sessionPath), { cwdOverride })
    if (!result.cancelled) this.emitHeadIfChanged()
    return {
      operation: "switch",
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: this.getSessionFile() ?? null,
      targetCwd: this.getCwd(),
      cancelled: Boolean(result.cancelled),
    }
  }

  async fork(entryId: string, position: "before" | "at"): Promise<JsonObject> {
    await this.runtime.session.waitForIdle()
    const sourceSessionId = this.getSessionId()
    const result = await this.runtime.fork(entryId, { position })
    if (!result.cancelled) this.emitHeadIfChanged()
    return {
      operation: "fork",
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: this.getSessionFile() ?? null,
      targetCwd: this.getCwd(),
      selectedText: toJson(result.selectedText) ?? null,
      cancelled: Boolean(result.cancelled),
    }
  }

  async clone(entryId?: string): Promise<JsonObject> {
    const target = entryId ?? this.runtime.session.sessionManager.getLeafId() ?? ""
    if (!target) throw Object.assign(new Error("Pi session has no entry to clone"), { code: "INVALID_REQUEST" })
    const result = await this.fork(target, "at")
    return { ...result, operation: "clone" }
  }

  async importSession(inputPath: string, cwdOverride?: string): Promise<JsonObject> {
    await this.runtime.session.waitForIdle()
    const sourceSessionId = this.getSessionId()
    const sourcePath = resolveUserPath(inputPath)
    if (!existsSync(sourcePath)) {
      throw Object.assign(new Error(`Import file not found: ${sourcePath}`), { code: "NOT_FOUND" })
    }
    const sessionDir = this.runtime.session.sessionManager.getSessionDir()
    mkdirSync(sessionDir, { recursive: true })
    const stagedPath = path.join(sessionDir, `piui-import-${randomUUID()}.jsonl`)
    copyFileSync(sourcePath, stagedPath, constants.COPYFILE_EXCL)
    let keepStagedFile = false
    try {
      const result = await this.runtime.importFromJsonl(stagedPath, cwdOverride)
      keepStagedFile = !result.cancelled
      if (!result.cancelled) this.emitHeadIfChanged()
      return {
        operation: "import",
        sourceSessionId,
        targetSessionId: this.getSessionId(),
        targetSessionFile: this.getSessionFile() ?? null,
        targetCwd: this.getCwd(),
        cancelled: Boolean(result.cancelled),
      }
    } finally {
      if (!keepStagedFile) {
        try {
          unlinkSync(stagedPath)
        } catch {
          /* best effort cleanup for a cancelled or failed import */
        }
      }
    }
  }

  async setSessionName(name: string): Promise<void> {
    this.runtime.session.setSessionName(name)
    this.emitHeadIfChanged()
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const session = this.runtime.session
    const model = session.modelRuntime?.getModel?.(provider, modelId)
    if (!model) throw Object.assign(new Error(`model not found: ${provider}/${modelId}`), { code: "MODEL_NOT_AVAILABLE" })
    await session.setModel(model)
  }

  async cycleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
    const result = await this.runtime.session.cycleModel(direction)
    if (!result) throw Object.assign(new Error("no authenticated model is available to cycle to"), {
      code: "MODEL_NOT_AVAILABLE",
    })
  }

  async setScopedModels(patterns: string[]): Promise<JsonValue | undefined> {
    const { resolveModelScopeWithDiagnostics } = getLoadedSdk().sdk
    const normalized = patterns.map(pattern => pattern.trim()).filter(Boolean)
    const result = await resolveModelScopeWithDiagnostics(normalized, this.runtime.session.modelRuntime)
    this.runtime.session.setScopedModels(result.scopedModels)
    return toJson(result.diagnostics)
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.runtime.session.setThinkingLevel(level as never)
  }

  async cycleThinkingLevel(): Promise<JsonValue | undefined> {
    const level = this.runtime.session.cycleThinkingLevel()
    if (level === undefined) {
      throw Object.assign(new Error("the selected Pi model does not support thinking levels"), {
        code: "CAPABILITY_DISABLED",
      })
    }
    return String(level)
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    this.runtime.session.setSteeringMode(mode)
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    this.runtime.session.setFollowUpMode(mode)
  }

  async clearQueue(): Promise<JsonValue | undefined> {
    return toJson(this.runtime.session.clearQueue())
  }

  async compact(customInstructions?: string): Promise<JsonValue | undefined> {
    try {
      const result = await this.runtime.session.compact(customInstructions)
      this.emitHeadIfChanged()
      return toJson({ status: "completed", result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/nothing to compact/i.test(message)) {
        return { status: "skipped", reason: "session_too_small", message }
      }
      if (/already compacted/i.test(message)) {
        return { status: "skipped", reason: "already_compacted", message }
      }
      if (/compaction cancelled/i.test(message)) return { status: "aborted" }
      throw error
    }
  }

  async abortCompaction(): Promise<void> {
    this.runtime.session.abortCompaction?.()
  }

  async abortBranchSummary(): Promise<void> {
    this.runtime.session.abortBranchSummary()
  }

  async abortRetry(): Promise<void> {
    this.runtime.session.abortRetry()
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.runtime.session.setAutoCompactionEnabled(enabled)
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    this.runtime.session.setAutoRetryEnabled(enabled)
  }

  async bash(command: string, excludeFromContext = false): Promise<JsonValue | undefined> {
    const normalized = command.trim()
    if (!normalized) throw Object.assign(new Error("empty bash command"), { code: "INVALID_REQUEST" })
    try {
      const eventResult = await this.runtime.session.extensionRunner?.emitUserBash({
        type: "user_bash",
        command: normalized,
        excludeFromContext,
        cwd: this.getCwd(),
      })
      if (eventResult?.result) {
        this.runtime.session.recordBashResult(normalized, eventResult.result, { excludeFromContext })
        return toJson(eventResult.result)
      }
      return toJson(await this.runtime.session.executeBash(normalized, undefined, {
        excludeFromContext,
        operations: eventResult?.operations,
      }))
    } finally {
      this.emitHeadIfChanged()
    }
  }

  async abortBash(): Promise<void> {
    this.runtime.session.abortBash()
  }

  async setActiveTools(toolNames: string[]): Promise<void> {
    const available = new Set(this.runtime.session.getAllTools().map(tool => tool.name))
    const normalized = [...new Set(toolNames)]
    const unknown = normalized.filter(name => !available.has(name))
    if (unknown.length > 0) {
      throw Object.assign(new Error(`Unknown Pi tools: ${unknown.join(", ")}`), { code: "INVALID_REQUEST" })
    }
    this.runtime.session.setActiveToolsByName(normalized)
  }

  async navigateTree(
    entryId: string,
    options: {
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    } = {},
  ): Promise<JsonObject> {
    await this.runtime.session.waitForIdle()
    if (options.summarize) {
      this.isCompactingFlag = true
      this.compactionShadow = {
        ...this.compactionShadow,
        operation: { type: "branchSummary", phase: "running", targetEntryId: entryId },
      }
    }
    let result: Awaited<ReturnType<AgentSessionRuntime["session"]["navigateTree"]>>
    try {
      result = await this.runtime.session.navigateTree(entryId, options)
    } finally {
      if (options.summarize) {
        this.isCompactingFlag = false
        this.compactionShadow = { ...this.compactionShadow, operation: { type: "none" } }
      }
    }
    if (!result.cancelled) this.emitHeadIfChanged()
    return {
      editorText: toJson(result.editorText) ?? null,
      cancelled: Boolean(result.cancelled),
      aborted: Boolean(result.aborted),
      summaryEntry: result.summaryEntry ? toJsonObject(result.summaryEntry) : null,
    }
  }

  async setLabel(entryId: string, label?: string): Promise<void> {
    this.runtime.session.sessionManager.appendLabelChange(entryId, label)
    this.emitHeadIfChanged()
  }

  async sendCustomMessage(
    customType: string,
    content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
    options: {
      display: boolean
      details?: JsonValue
      triggerTurn?: boolean
      deliverAs?: "steer" | "followUp" | "nextTurn"
    },
  ): Promise<void> {
    if (!customType.trim()) throw Object.assign(new Error("custom message type required"), { code: "INVALID_REQUEST" })
    await this.runtime.session.sendCustomMessage({
      customType: customType.trim(),
      content,
      display: options.display,
      details: options.details,
    }, {
      triggerTurn: options.triggerTurn,
      deliverAs: options.deliverAs,
    })
    this.emitHeadIfChanged()
  }

  async appendCustomEntry(customType: string, data?: JsonValue): Promise<void> {
    const normalized = customType.trim()
    if (!normalized) throw Object.assign(new Error("custom entry type required"), { code: "INVALID_REQUEST" })
    this.runtime.session.sessionManager.appendCustomEntry(normalized, data)
    this.emitHeadIfChanged()
  }

  async exportHtml(outputPath: string): Promise<JsonValue | undefined> {
    return toJson({ path: await this.runtime.session.exportToHtml(outputPath) })
  }

  async exportJsonl(outputPath: string): Promise<JsonValue | undefined> {
    return toJson({ path: this.runtime.session.exportToJsonl(outputPath) })
  }

  async waitForIdle(): Promise<void> {
    await this.runtime.session.waitForIdle()
  }

  async reload(): Promise<void> {
    this.extensionUi.cancelAll("runtime_reloaded")
    await this.runtime.session.reload()
    this.nativeFingerprint = ""
    this.emitHeadIfChanged()
    for (const listener of this.resourceListeners) listener()
  }

  async dispose(): Promise<void> {
    this.extensionUi.cancelAll("runtime_disposed")
    this.detachSessionSubscriptions()
    this.piEventListeners.clear()
    this.headListeners.clear()
    this.resourceListeners.clear()
    await this.runtime.dispose()
  }
}

function toJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString()
    if (typeof item === "function" || typeof item === "symbol") return undefined
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack }
    return item
  })) as JsonValue
}

function toJsonObject(value: unknown): JsonObject {
  const json = toJson(value)
  if (!isJsonObject(json)) {
    throw Object.assign(new Error("Pi native data is not a JSON object"), { code: "NATIVE_DATA_NOT_JSON" })
  }
  return json
}

function pathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}
