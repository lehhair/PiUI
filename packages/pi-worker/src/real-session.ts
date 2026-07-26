/**
 * Real Pi AgentSessionRuntime wrapper.
 * Only used when PIUI_DRIVER=pi. Will call configured models.
 */
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultPackageManager,
  getAgentDir,
  ModelRuntime,
  ProjectTrustStore,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
  hasTrustRequiringProjectResources,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type SessionEntry,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent"
import type {
  CompactionCommandResultV1,
  CompactionResultV1,
  CompactionStateV1,
  PiSessionEntryV1,
  PiSessionTreeNodeV1,
  PiToolInfoV1,
  PiSettingsPatchV1,
  PiSettingsSnapshotV1,
  ProjectTrustV1,
  ContextUsageV1,
  SessionStatsV1,
  ScopedModelV1,
  ConfiguredPackageV1,
  PackageProgressV1,
  PiResourceSnapshotV1,
  PiResourceExtensionPathsV1,
  PiRuntimeInspectionV1,
  ResolvedPackageResourcesV1,
  PackageUpdateV1,
  CustomMessageContentV1,
  QueueDeliveryModeV1,
  RetryStateV1,
  SessionReplacementResultV1,
} from "@piui/protocol"
import { constants, copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"
import {
  applyWorkerEvent,
  createProjectionState,
  projectEntries,
  type ProjectionDelta,
  type ProjectionState,
} from "./projection.js"
import type { PiContentBlock, PiEntry, WorkerEvent } from "./types.js"
import type { PiBashResult, PiImageInput, PiModelInfo } from "./worker-protocol.js"
import { ExtensionUiBridge, type PiExtensionUiEvent } from "./extension-ui-bridge.js"

export interface PiRuntimeUiState {
  thinkingLevel: string
  availableThinkingLevels: string[]
  isStreaming: boolean
  isCompacting: boolean
  isIdle: boolean
  queue: {
    steering: string[]
    followUp: string[]
    steeringMode: QueueDeliveryModeV1
    followUpMode: QueueDeliveryModeV1
  }
  retry: RetryStateV1
  compaction: CompactionStateV1
  tools: PiToolInfoV1[]
  activeTools: string[]
  model?: { provider: string; id: string; displayName: string }
  supportsThinking: boolean
  contextUsage?: ContextUsageV1
  sessionStats?: SessionStatsV1
  scopedModels: ScopedModelV1[]
}

export interface PiSkillInfo {
  name: string
  description?: string
  source?: string
}

export interface PiCommandInfo {
  name: string
  description?: string
  source: "skill" | "prompt" | "extension" | "builtin"
}

export interface PiSessionInfo {
  id: string
  path: string
  cwd: string
  name?: string
  createdAt: string
  updatedAt: string
  messageCount: number
  firstMessage: string
}

function extensionBindings(
  uiContext: ExtensionUiBridge["context"],
  runtime: AgentSessionRuntime,
  navigateTree: RealPiSession["navigateTree"],
  reload: RealPiSession["reload"],
) {
  return {
    mode: "rpc" as const,
    uiContext,
    commandContextActions: {
      waitForIdle: () => runtime.session.waitForIdle(),
      newSession: () => unsupportedExtensionSessionReplacement("newSession"),
      fork: () => unsupportedExtensionSessionReplacement("fork"),
      navigateTree: async (entryId: string, options?: {
        summarize?: boolean
        customInstructions?: string
        replaceInstructions?: boolean
        label?: string
      }) => {
        const result = await navigateTree(entryId, options)
        return { cancelled: result.cancelled }
      },
      switchSession: () => unsupportedExtensionSessionReplacement("switchSession"),
      reload,
    },
    abortHandler: () => { void runtime.session.abort() },
    shutdownHandler: () => {
      throw Object.assign(new Error("Extension-requested host shutdown is not available in the remote worker"), {
        code: "CAPABILITY_DISABLED",
      })
    },
    onError: (error: { extensionPath: string; event: string; error: string }) => {
      console.error(`[piui-worker] extension error (${error.event}) ${error.extensionPath}: ${error.error}`)
    },
  }
}

function unsupportedExtensionSessionReplacement(action: string): Promise<never> {
  return Promise.reject(Object.assign(
    new Error(`Extension command context ${action} requires host coordination unavailable in Pi SDK 0.81.1`),
    { code: "CAPABILITY_DISABLED" },
  ))
}

export interface RealPiSessionOpenOptions {
  agentDir?: string
  createRuntime?: CreateAgentSessionRuntimeFactory
  createSessionManager?: (cwd: string, sessionFile?: string) => SessionManager
}

const createDefaultRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  sessionManager,
  sessionStartEvent,
}) => {
  const agentDir = getAgentDir()
  const globalSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
  const required = hasTrustRequiringProjectResources(cwd)
  const savedDecision = new ProjectTrustStore(agentDir).get(cwd)
  const defaultTrust = globalSettings.getDefaultProjectTrust()
  const projectTrusted = !required || (savedDecision ?? defaultTrust === "always")
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted })
  const services = await createAgentSessionServices({ cwd, agentDir, settingsManager })
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

function settingsForWorkspace(cwd: string): { manager: SettingsManager; trusted: boolean } {
  const trust = RealPiSession.getProjectTrust(cwd)
  return {
    manager: SettingsManager.create(cwd, getAgentDir(), { projectTrusted: trust.trusted }),
    trusted: trust.trusted,
  }
}

function packageManagerForWorkspace(cwd: string): DefaultPackageManager {
  const { manager } = settingsForWorkspace(cwd)
  return new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: manager })
}

function settingsSnapshot(cwd: string, manager: SettingsManager, trusted: boolean): PiSettingsSnapshotV1 {
  return {
    workspacePath: cwd,
    projectTrusted: trusted,
    global: manager.getGlobalSettings(),
    project: manager.getProjectSettings(),
    effective: {
      lastChangelogVersion: manager.getLastChangelogVersion(),
      sessionDir: manager.getSessionDir(),
      defaultProvider: manager.getDefaultProvider(),
      defaultModel: manager.getDefaultModel(),
      defaultThinkingLevel: manager.getDefaultThinkingLevel(),
      transport: manager.getTransport(),
      steeringMode: manager.getSteeringMode(),
      followUpMode: manager.getFollowUpMode(),
      theme: manager.getThemeSetting(),
      compaction: manager.getCompactionSettings(),
      branchSummary: manager.getBranchSummarySettings(),
      retry: manager.getRetrySettings(),
      providerRetry: manager.getProviderRetrySettings(),
      httpIdleTimeoutMs: manager.getHttpIdleTimeoutMs(),
      websocketConnectTimeoutMs: manager.getWebSocketConnectTimeoutMs(),
      externalEditor: manager.getExternalEditorCommand(),
      hideThinkingBlock: manager.getHideThinkingBlock(),
      showCacheMissNotices: manager.getShowCacheMissNotices(),
      shellPath: manager.getShellPath(),
      shellCommandPrefix: manager.getShellCommandPrefix(),
      quietStartup: manager.getQuietStartup(),
      defaultProjectTrust: manager.getDefaultProjectTrust(),
      npmCommand: manager.getNpmCommand(),
      enableAnalytics: manager.getEnableAnalytics(),
      trackingId: manager.getTrackingId(),
      enableInstallTelemetry: manager.getEnableInstallTelemetry(),
      collapseChangelog: manager.getCollapseChangelog(),
      enableSkillCommands: manager.getEnableSkillCommands(),
      packages: manager.getPackages(),
      extensionPaths: manager.getExtensionPaths(),
      skillPaths: manager.getSkillPaths(),
      promptTemplatePaths: manager.getPromptTemplatePaths(),
      themePaths: manager.getThemePaths(),
      showImages: manager.getShowImages(),
      imageWidthCells: manager.getImageWidthCells(),
      imageAutoResize: manager.getImageAutoResize(),
      blockImages: manager.getBlockImages(),
      enabledModels: manager.getEnabledModels(),
      thinkingBudgets: manager.getThinkingBudgets(),
      doubleEscapeAction: manager.getDoubleEscapeAction(),
      treeFilterMode: manager.getTreeFilterMode(),
      clearOnShrink: manager.getClearOnShrink(),
      showTerminalProgress: manager.getShowTerminalProgress(),
      showHardwareCursor: manager.getShowHardwareCursor(),
      editorPaddingX: manager.getEditorPaddingX(),
      outputPad: manager.getOutputPad(),
      autocompleteMaxVisible: manager.getAutocompleteMaxVisible(),
      codeBlockIndent: manager.getCodeBlockIndent(),
      warnings: manager.getWarnings(),
    },
    errors: manager.drainErrors().map(error => ({ scope: error.scope, message: error.error.message })),
  }
}

function applySettingsPatch(manager: SettingsManager, patch: PiSettingsPatchV1): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "defaultModelAndProvider") {
      const pair = expectRecord(key, value)
      manager.setDefaultModelAndProvider(expectString("provider", pair.provider), expectString("model", pair.model))
    }
    else if (key === "lastChangelogVersion") manager.setLastChangelogVersion(expectString(key, value))
    else if (key === "defaultProvider") manager.setDefaultProvider(expectString(key, value))
    else if (key === "defaultModel") manager.setDefaultModel(expectString(key, value))
    else if (key === "defaultThinkingLevel") manager.setDefaultThinkingLevel(expectEnum(key, value, ["off", "minimal", "low", "medium", "high", "xhigh"]))
    else if (key === "transport") manager.setTransport(expectEnum(key, value, ["auto", "sse", "websocket"]))
    else if (key === "steeringMode") manager.setSteeringMode(expectEnum(key, value, ["all", "one-at-a-time"]))
    else if (key === "followUpMode") manager.setFollowUpMode(expectEnum(key, value, ["all", "one-at-a-time"]))
    else if (key === "theme") manager.setTheme(expectString(key, value))
    else if (key === "compactionEnabled") manager.setCompactionEnabled(expectBoolean(key, value))
    else if (key === "retryEnabled") manager.setRetryEnabled(expectBoolean(key, value))
    else if (key === "httpIdleTimeoutMs") manager.setHttpIdleTimeoutMs(expectNumber(key, value))
    else if (key === "hideThinkingBlock") manager.setHideThinkingBlock(expectBoolean(key, value))
    else if (key === "showCacheMissNotices") manager.setShowCacheMissNotices(expectBoolean(key, value))
    else if (key === "shellPath") manager.setShellPath(expectOptionalString(key, value))
    else if (key === "shellCommandPrefix") manager.setShellCommandPrefix(expectOptionalString(key, value))
    else if (key === "quietStartup") manager.setQuietStartup(expectBoolean(key, value))
    else if (key === "defaultProjectTrust") manager.setDefaultProjectTrust(expectEnum(key, value, ["always", "never", "ask"]))
    else if (key === "npmCommand") manager.setNpmCommand(expectOptionalStringArray(key, value))
    else if (key === "enableAnalytics") manager.setEnableAnalytics(expectBoolean(key, value))
    else if (key === "enableInstallTelemetry") manager.setEnableInstallTelemetry(expectBoolean(key, value))
    else if (key === "collapseChangelog") manager.setCollapseChangelog(expectBoolean(key, value))
    else if (key === "enableSkillCommands") manager.setEnableSkillCommands(expectBoolean(key, value))
    else if (key === "packages") manager.setPackages(expectArray(key, value) as never)
    else if (key === "projectPackages") manager.setProjectPackages(expectArray(key, value) as never)
    else if (key === "extensionPaths") manager.setExtensionPaths(expectStringArray(key, value))
    else if (key === "projectExtensionPaths") manager.setProjectExtensionPaths(expectStringArray(key, value))
    else if (key === "skillPaths") manager.setSkillPaths(expectStringArray(key, value))
    else if (key === "projectSkillPaths") manager.setProjectSkillPaths(expectStringArray(key, value))
    else if (key === "promptTemplatePaths") manager.setPromptTemplatePaths(expectStringArray(key, value))
    else if (key === "projectPromptTemplatePaths") manager.setProjectPromptTemplatePaths(expectStringArray(key, value))
    else if (key === "themePaths") manager.setThemePaths(expectStringArray(key, value))
    else if (key === "projectThemePaths") manager.setProjectThemePaths(expectStringArray(key, value))
    else if (key === "showImages") manager.setShowImages(expectBoolean(key, value))
    else if (key === "imageWidthCells") manager.setImageWidthCells(expectNumber(key, value))
    else if (key === "imageAutoResize") manager.setImageAutoResize(expectBoolean(key, value))
    else if (key === "blockImages") manager.setBlockImages(expectBoolean(key, value))
    else if (key === "enabledModels") manager.setEnabledModels(expectOptionalStringArray(key, value))
    else if (key === "doubleEscapeAction") manager.setDoubleEscapeAction(expectEnum(key, value, ["fork", "tree", "none"]))
    else if (key === "treeFilterMode") manager.setTreeFilterMode(expectEnum(key, value, ["default", "no-tools", "user-only", "labeled-only", "all"]))
    else if (key === "clearOnShrink") manager.setClearOnShrink(expectBoolean(key, value))
    else if (key === "showTerminalProgress") manager.setShowTerminalProgress(expectBoolean(key, value))
    else if (key === "showHardwareCursor") manager.setShowHardwareCursor(expectBoolean(key, value))
    else if (key === "editorPaddingX") manager.setEditorPaddingX(expectNumber(key, value))
    else if (key === "outputPad") manager.setOutputPad(expectOutputPad(key, value))
    else if (key === "autocompleteMaxVisible") manager.setAutocompleteMaxVisible(expectNumber(key, value))
    else if (key === "warnings") manager.setWarnings(expectRecord(key, value) as never)
    else throw Object.assign(new Error(`unsupported Pi setting: ${key}`), { code: "INVALID_REQUEST" })
  }
}

function expectString(key: string, value: unknown): string {
  if (typeof value !== "string") throw invalidSetting(key)
  return value
}

function expectOptionalString(key: string, value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  return expectString(key, value)
}

function expectBoolean(key: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw invalidSetting(key)
  return value
}

function expectNumber(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidSetting(key)
  return value
}

function expectEnum<T extends string>(key: string, value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw invalidSetting(key)
  return value as T
}

function expectOptionalStringArray(key: string, value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw invalidSetting(key)
  return value
}

function expectStringArray(key: string, value: unknown): string[] {
  const result = expectOptionalStringArray(key, value)
  if (!result) throw invalidSetting(key)
  return result
}

function expectRecord(key: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidSetting(key)
  return value as Record<string, unknown>
}

function expectArray(key: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) throw invalidSetting(key)
  return value
}

function expectOutputPad(key: string, value: unknown): 0 | 1 {
  if (value !== 0 && value !== 1) throw invalidSetting(key)
  return value
}

function invalidSetting(key: string): Error {
  return Object.assign(new Error(`invalid Pi setting: ${key}`), { code: "INVALID_REQUEST" })
}

export class RealPiSession {
  private runtime: AgentSessionRuntime
  private readonly extensionUi: ExtensionUiBridge
  private extensionsInitialized = false
  private projection: ProjectionState = createProjectionState()
  private stateUnsub: (() => void) | null = null
  private lastUserId: string | null = null
  private currentAsstId: string | null = null
  private stateListeners = new Set<(s: PiRuntimeUiState) => void>()
  private projectionListeners = new Set<(projection: ProjectionState) => void>()
  private projectionDeltaListeners = new Set<(projection: ProjectionDelta) => void>()
  private nativeEventListeners = new Set<(event: unknown) => void>()
  private resourceListeners = new Set<() => void>()
  /** last known runtime flags from events */
  private isCompactingFlag = false
  private retryState: RetryStateV1 = { phase: "idle", autoEnabled: true }
  private compactionState: CompactionStateV1 = {
    autoEnabled: true,
    operation: { type: "none" },
  }

  private constructor(runtime: AgentSessionRuntime) {
    this.runtime = runtime
    this.extensionUi = new ExtensionUiBridge(
      () => this.runtime.session.sessionManager.getSessionId(),
      () => undefined,
    )
    this.bindStateEvents()
  }

  private bindStateEvents(): void {
    this.stateUnsub?.()
    this.stateUnsub = this.runtime.session.subscribe(event => {
      const nativeEvent = toJsonValue(event)
      for (const listener of this.nativeEventListeners) listener(nativeEvent)
      let projectionChanged = false
      for (const workerEvent of mapPiEventToWorker(event, this)) {
        this.projection = applyWorkerEvent(this.projection, workerEvent)
        projectionChanged = true
      }
      if (projectionChanged) {
        this.emitProjection()
        this.emitProjectionDelta()
      }

      if (event.type === "compaction_start") {
        this.isCompactingFlag = true
        this.compactionState = {
          ...this.compactionState,
          operation: { type: "compaction", phase: "running", reason: event.reason },
          lastAborted: undefined,
          lastError: undefined,
          lastNotice: undefined,
        }
      } else if (event.type === "compaction_end") {
        this.isCompactingFlag = false
        this.compactionState = {
          ...this.compactionState,
          operation: { type: "none" },
          lastResult: event.result ? mapCompactionResult(event.result) : this.compactionState.lastResult,
          lastAborted: event.aborted,
          lastError: event.errorMessage,
        }
      } else if (event.type === "auto_retry_start") {
        this.retryState = {
          phase: "waiting",
          autoEnabled: this.runtime.session.autoRetryEnabled,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          nextAttemptAt: new Date(Date.now() + event.delayMs).toISOString(),
          errorMessage: event.errorMessage,
        }
      } else if (event.type === "agent_start" && this.retryState.phase === "waiting") {
        this.retryState = {
          phase: "running",
          autoEnabled: this.runtime.session.autoRetryEnabled,
          attempt: this.retryState.attempt,
          maxAttempts: this.retryState.maxAttempts,
        }
      } else if (event.type === "agent_start" && this.retryState.phase === "finished") {
        this.retryState = { phase: "idle", autoEnabled: this.runtime.session.autoRetryEnabled }
      } else if (event.type === "auto_retry_end") {
        this.retryState = {
          phase: "finished",
          autoEnabled: this.runtime.session.autoRetryEnabled,
          success: event.success,
          attempt: event.attempt,
          finalError: event.finalError,
        }
      } else if (event.type === "summarization_retry_scheduled") {
        const operation = this.compactionState.operation
        if (operation.type !== "none") {
          this.compactionState = {
            ...this.compactionState,
            operation: {
              ...operation,
              phase: "retrying",
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              errorMessage: event.errorMessage,
            },
          }
        }
      } else if (event.type === "summarization_retry_attempt_start") {
        const operation = this.compactionState.operation
        if (operation.type !== "none") {
          this.compactionState = { ...this.compactionState, operation: { ...operation, phase: "running" } }
        }
      }

      if (isRuntimeStateEvent(event.type)) this.emitState()
      if (event.type === "message_end" || event.type === "agent_settled" || event.type === "entry_appended") {
        queueMicrotask(() => {
          const previous = this.projection
          this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
          this.emitProjection()
          this.emitProjectionReconciliation(previous)
          this.emitState()
        })
      }
    })
  }

  private detachSessionSubscriptions(): void {
    this.stateUnsub?.()
    this.stateUnsub = null
  }

  static async open(
    cwd: string,
    sessionFile?: string,
    options: RealPiSessionOpenOptions = {},
  ): Promise<RealPiSession> {
    if (sessionFile && !existsSync(sessionFile)) {
      throw Object.assign(new Error("Pi session file no longer exists"), { code: "SESSION_FILE_NOT_FOUND" })
    }
    const sessionManager = options.createSessionManager?.(cwd, sessionFile) ??
      (sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd))
    if (sessionFile && pathKey(sessionManager.getCwd()) !== pathKey(cwd)) {
      throw Object.assign(new Error("Pi session workspace does not match the selected workspace"), {
        code: "SESSION_WORKSPACE_MISMATCH",
      })
    }
    const projection = sessionFile ? projectNativeBranch(sessionManager.getBranch()) : undefined
    const runtime = await createAgentSessionRuntime(options.createRuntime ?? createDefaultRuntime, {
      cwd: sessionManager.getCwd(),
      agentDir: options.agentDir ?? getAgentDir(),
      sessionManager,
    })

    const result = new RealPiSession(runtime)
    runtime.setBeforeSessionInvalidate(() => result.detachSessionSubscriptions())
    runtime.setRebindSession(async session => {
      result.extensionUi.cancelAll("session_replaced")
      if (result.extensionsInitialized) {
        await session.bindExtensions(extensionBindings(
          result.extensionUi.context,
          result.runtime,
          result.navigateTree.bind(result),
          result.reload.bind(result),
        ))
      }
      result.bindStateEvents()
    })
    if (projection) result.projection = projection
    return result
  }

  async initializeExtensions(): Promise<void> {
    if (this.extensionsInitialized) return
    await this.runtime.session.bindExtensions(extensionBindings(
      this.extensionUi.context,
      this.runtime,
      this.navigateTree.bind(this),
      this.reload.bind(this),
    ))
    this.extensionsInitialized = true
  }

  onExtensionUi(listener: (event: PiExtensionUiEvent) => void): () => void {
    return this.extensionUi.onEvent(listener)
  }

  respondExtensionUi(requestId: string, response: import("@piui/protocol").ExtensionUiDialogResponseV1): boolean {
    return this.extensionUi.respond(requestId, response)
  }

  setExtensionEditorState(text: string): void {
    this.extensionUi.setEditorState(text)
  }

  static async list(cwd: string): Promise<PiSessionInfo[]> {
    return (await SessionManager.list(cwd)).map(sessionInfo)
  }

  static async listAll(): Promise<PiSessionInfo[]> {
    return (await SessionManager.listAll()).map(sessionInfo)
  }

  static async listModels(): Promise<PiModelInfo[]> {
    const runtime = await ModelRuntime.create({ allowModelNetwork: false })
    return (await runtime.getAvailable()).map(modelInfo)
  }

  static getSettings(cwd: string): PiSettingsSnapshotV1 {
    const { manager, trusted } = settingsForWorkspace(cwd)
    return settingsSnapshot(cwd, manager, trusted)
  }

  static async patchSettings(cwd: string, patch: PiSettingsPatchV1): Promise<PiSettingsSnapshotV1> {
    const { manager, trusted } = settingsForWorkspace(cwd)
    applySettingsPatch(manager, patch)
    await manager.flush()
    return settingsSnapshot(cwd, manager, trusted)
  }

  static getProjectTrust(cwd: string): ProjectTrustV1 {
    const agentDir = getAgentDir()
    const store = new ProjectTrustStore(agentDir)
    const entry = store.getEntry(cwd)
    const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
    const defaultDecision = manager.getDefaultProjectTrust()
    const required = hasTrustRequiringProjectResources(cwd)
    const decision = store.get(cwd)
    return {
      workspacePath: cwd,
      required,
      decision,
      inheritedFrom: entry?.path,
      defaultDecision,
      trusted: !required || (decision ?? defaultDecision === "always"),
    }
  }

  static setProjectTrust(cwd: string, decision: boolean | null): ProjectTrustV1 {
    new ProjectTrustStore(getAgentDir()).set(cwd, decision)
    return RealPiSession.getProjectTrust(cwd)
  }

  static listPackages(cwd: string): ConfiguredPackageV1[] {
    const { manager } = settingsForWorkspace(cwd)
    return new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: manager })
      .listConfiguredPackages()
      .map(pkg => ({ ...pkg }))
  }

  static async managePackage(
    cwd: string,
    commandId: string,
    action: "install" | "remove" | "update",
    source: string | undefined,
    local: boolean,
    persist: boolean,
    onProgress: (event: PackageProgressV1) => void,
  ): Promise<ConfiguredPackageV1[]> {
    const { manager } = settingsForWorkspace(cwd)
    const packages = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: manager })
    packages.setProgressCallback(event => onProgress({ ...event, commandId }))
    if (action === "install") {
      if (!source) throw Object.assign(new Error("package source required"), { code: "INVALID_REQUEST" })
      await (persist ? packages.installAndPersist(source, { local }) : packages.install(source, { local }))
    } else if (action === "remove") {
      if (!source) throw Object.assign(new Error("package source required"), { code: "INVALID_REQUEST" })
      if (persist) await packages.removeAndPersist(source, { local })
      else await packages.remove(source, { local })
    } else {
      await packages.update(source)
    }
    await manager.flush()
    return packages.listConfiguredPackages().map(pkg => ({ ...pkg }))
  }

  static async resolvePackages(
    cwd: string,
    missingAction: "skip" | "error" = "skip",
  ): Promise<ResolvedPackageResourcesV1> {
    const packages = packageManagerForWorkspace(cwd)
    return packages.resolve(async () => missingAction)
  }

  static async resolveExtensionSources(
    cwd: string,
    sources: string[],
    options: { local?: boolean; temporary?: boolean } = {},
  ): Promise<ResolvedPackageResourcesV1> {
    return packageManagerForWorkspace(cwd).resolveExtensionSources(sources, options)
  }

  static async changePackageSource(
    cwd: string,
    source: string,
    operation: "add" | "remove",
    local = false,
  ): Promise<{ changed: boolean; packages: ConfiguredPackageV1[] }> {
    const { manager } = settingsForWorkspace(cwd)
    const packages = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: manager })
    const changed = operation === "add"
      ? packages.addSourceToSettings(source, { local })
      : packages.removeSourceFromSettings(source, { local })
    await manager.flush()
    return { changed, packages: packages.listConfiguredPackages().map(pkg => ({ ...pkg })) }
  }

  static getInstalledPackagePath(cwd: string, source: string, scope: "user" | "project"): string | undefined {
    return packageManagerForWorkspace(cwd).getInstalledPath(source, scope)
  }

  static checkPackageUpdates(cwd: string): Promise<PackageUpdateV1[]> {
    return packageManagerForWorkspace(cwd).checkForAvailableUpdates()
  }

  onState(listener: (s: PiRuntimeUiState) => void): () => void {
    this.stateListeners.add(listener)
    listener(this.getRuntimeUiState())
    return () => this.stateListeners.delete(listener)
  }

  onProjection(listener: (projection: ProjectionState) => void): () => void {
    this.projectionListeners.add(listener)
    listener(this.projection)
    return () => this.projectionListeners.delete(listener)
  }

  onProjectionDelta(listener: (projection: ProjectionDelta) => void): () => void {
    this.projectionDeltaListeners.add(listener)
    return () => this.projectionDeltaListeners.delete(listener)
  }

  onNativeEvent(listener: (event: unknown) => void): () => void {
    this.nativeEventListeners.add(listener)
    return () => this.nativeEventListeners.delete(listener)
  }

  onResourcesChanged(listener: () => void): () => void {
    this.resourceListeners.add(listener)
    return () => this.resourceListeners.delete(listener)
  }

  private emitState() {
    const s = this.getRuntimeUiState()
    for (const l of this.stateListeners) l(s)
  }

  private emitProjection(): void {
    for (const listener of this.projectionListeners) listener(this.projection)
  }

  private emitProjectionDelta(): void {
    const delta = { ...this.projection, timeline: this.projection.timeline.slice(-1) }
    for (const listener of this.projectionDeltaListeners) listener(delta)
  }

  private emitProjectionReconciliation(previous: ProjectionState): void {
    const nextById = new Map(this.projection.timeline.map(item => [item.id, item]))
    const previousById = new Map(previous.timeline.map(item => [item.id, item]))
    const removedItemIds = previous.timeline
      .filter(item => !nextById.has(item.id))
      .map(item => item.id)
    const changed = this.projection.timeline.filter(item => {
      const old = previousById.get(item.id)
      return !old || JSON.stringify(old) !== JSON.stringify(item)
    }).slice(-2)
    if (removedItemIds.length === 0 && changed.length === 0) return
    const delta: ProjectionDelta = {
      timeline: changed,
      isStreaming: this.projection.isStreaming,
      removedItemIds,
    }
    for (const listener of this.projectionDeltaListeners) listener(delta)
  }

  getProjection(): ProjectionState {
    return this.projection
  }

  getSessionId(): string {
    return this.runtime.session.sessionId
  }

  getSessionFile(): string | undefined {
    return this.runtime.session.sessionFile
  }

  getSessionName(): string | undefined {
    return this.runtime.session.sessionManager.getSessionName()
  }

  getEntries(): PiSessionEntryV1[] {
    return this.runtime.session.sessionManager.getEntries().map(mapSessionEntry)
  }

  getTree(): PiSessionTreeNodeV1[] {
    return mapSessionTree(this.runtime.session.sessionManager.getTree())
  }

  getLeafId(): string | null {
    return this.runtime.session.sessionManager.getLeafId()
  }

  getModel() {
    const m = this.runtime.session.model
    if (!m) return undefined
    return { provider: m.provider, id: m.id, displayName: m.name ?? m.id }
  }

  getThinkingLevel(): string {
    return String(this.runtime.session.thinkingLevel ?? "off")
  }

  getAvailableThinkingLevels(): string[] {
    try {
      const levels = this.runtime.session.getAvailableThinkingLevels?.() ?? []
      return levels.map(String)
    } catch {
      return ["off", "minimal", "low", "medium", "high"]
    }
  }

  isStreaming(): boolean {
    return this.runtime.session.isStreaming
  }

  getRuntimeUiState(): PiRuntimeUiState {
    const session = this.runtime.session
    const steering = [...(session.getSteeringMessages?.() ?? [])].map(String)
    const followUp = [...(session.getFollowUpMessages?.() ?? [])].map(String)
    const contextUsage = session.getContextUsage()
    const stats = session.getSessionStats()
    return {
      thinkingLevel: this.getThinkingLevel(),
      availableThinkingLevels: this.getAvailableThinkingLevels(),
      isStreaming: session.isStreaming,
      isCompacting: this.isCompactingFlag || Boolean(session.isCompacting),
      isIdle: Boolean(session.isIdle ?? !session.isStreaming),
      queue: {
        steering,
        followUp,
        steeringMode: session.steeringMode,
        followUpMode: session.followUpMode,
      },
      retry: { ...this.retryState, autoEnabled: session.autoRetryEnabled },
      compaction: { ...this.compactionState, autoEnabled: session.autoCompactionEnabled },
      tools: session.getAllTools().map(tool => ({
        name: tool.name,
        description: tool.description,
        source: toolSource(tool.sourceInfo),
      })),
      activeTools: session.getActiveToolNames?.() ?? [],
      model: this.getModel(),
      supportsThinking: Boolean(session.supportsThinking?.() ?? true),
      contextUsage: contextUsage ? {
        contextTokens: contextUsage.tokens ?? undefined,
        contextWindow: contextUsage.contextWindow,
        percent: contextUsage.percent,
      } : undefined,
      sessionStats: {
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        toolResults: stats.toolResults,
        totalMessages: stats.totalMessages,
        tokens: { ...stats.tokens },
        cost: stats.cost,
      },
      scopedModels: session.scopedModels.map(item => ({
        provider: item.model.provider,
        id: item.model.id,
        displayName: item.model.name,
        thinkingLevel: item.thinkingLevel,
      })),
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const session = this.runtime.session
    const modelRuntime = session.modelRuntime
    const model = modelRuntime?.getModel?.(provider, modelId)
    if (!model) {
      throw new Error(`model not found: ${provider}/${modelId}`)
    }
    await session.setModel(model)
    this.emitState()
  }

  setThinkingLevel(level: string): void {
    this.runtime.session.setThinkingLevel(level as never)
    this.emitState()
  }

  async compact(customInstructions?: string): Promise<CompactionCommandResultV1> {
    try {
      const result = await this.runtime.session.compact(customInstructions)
      this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
      this.emitProjection()
      this.emitState()
      return { status: "completed", result: mapCompactionResult(result) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/nothing to compact/i.test(message)) {
        this.compactionState = { ...this.compactionState, lastNotice: message, lastError: undefined }
        this.emitState()
        return { status: "skipped", reason: "session_too_small", message }
      }
      if (/already compacted/i.test(message)) {
        this.compactionState = { ...this.compactionState, lastNotice: message, lastError: undefined }
        this.emitState()
        return { status: "skipped", reason: "already_compacted", message }
      }
      if (/compaction cancelled/i.test(message)) return { status: "aborted" }
      throw error
    }
  }

  async navigateTree(
    entryId: string,
    options: {
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    } = {},
  ): Promise<{
    editorText?: string
    cancelled: boolean
    aborted?: boolean
    summaryEntry?: PiSessionEntryV1
  }> {
    await this.runtime.session.waitForIdle()
    if (options.summarize) {
      this.isCompactingFlag = true
      this.compactionState = {
        ...this.compactionState,
        operation: { type: "branchSummary", phase: "running", targetEntryId: entryId },
        lastAborted: undefined,
        lastError: undefined,
      }
      this.emitState()
    }
    let result: Awaited<ReturnType<AgentSessionRuntime["session"]["navigateTree"]>>
    try {
      result = await this.runtime.session.navigateTree(entryId, options)
    } finally {
      if (options.summarize) {
        this.isCompactingFlag = false
        this.compactionState = { ...this.compactionState, operation: { type: "none" } }
        this.emitState()
      }
    }
    if (options.summarize) {
      this.compactionState = { ...this.compactionState, lastAborted: Boolean(result.aborted) }
    }
    if (!result.cancelled) {
      this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
      this.emitProjection()
      this.emitState()
    }
    return {
      editorText: result.editorText,
      cancelled: result.cancelled,
      aborted: result.aborted,
      summaryEntry: result.summaryEntry ? mapSessionEntry(result.summaryEntry) : undefined,
    }
  }

  setLabel(entryId: string, label?: string): void {
    this.runtime.session.sessionManager.appendLabelChange(entryId, label)
    this.emitState()
  }

  setSessionName(name: string): void {
    this.runtime.session.setSessionName(name)
    this.emitState()
  }

  async fork(entryId: string, position: "before" | "at"): Promise<SessionReplacementResultV1> {
    await this.runtime.session.waitForIdle()
    const sourceSessionId = this.getSessionId()
    const result = await this.runtime.fork(entryId, { position })
    if (!result.cancelled) this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
    this.emitState()
    return {
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: this.getSessionFile(),
      targetCwd: this.runtime.cwd,
      selectedText: result.selectedText,
      cancelled: result.cancelled,
    }
  }

  async clone(entryId = this.getLeafId() ?? ""): Promise<SessionReplacementResultV1> {
    if (!entryId) throw Object.assign(new Error("Pi session has no entry to clone"), { code: "INVALID_REQUEST" })
    return this.fork(entryId, "at")
  }

  async newSession(parentSession?: string): Promise<SessionReplacementResultV1> {
    await this.runtime.session.waitForIdle()
    const sourceSessionId = this.getSessionId()
    const result = await this.runtime.newSession({ parentSession })
    if (!result.cancelled) this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
    this.emitState()
    return {
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: this.getSessionFile(),
      targetCwd: this.runtime.cwd,
      cancelled: result.cancelled,
    }
  }

  async switchSession(sessionPath: string, cwdOverride?: string): Promise<SessionReplacementResultV1> {
    await this.runtime.session.waitForIdle()
    const sourceSessionId = this.getSessionId()
    const result = await this.runtime.switchSession(resolveUserPath(sessionPath), { cwdOverride })
    if (!result.cancelled) this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
    this.emitState()
    return {
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: this.getSessionFile(),
      targetCwd: this.runtime.cwd,
      cancelled: result.cancelled,
    }
  }

  async importSession(inputPath: string, cwdOverride?: string): Promise<SessionReplacementResultV1> {
    await this.runtime.session.waitForIdle()
    const sourceSessionId = this.getSessionId()
    const sourcePath = resolveUserPath(inputPath)
    if (!existsSync(sourcePath)) {
      const error = new Error(`Import file not found: ${sourcePath}`)
      error.name = "SessionImportFileNotFoundError"
      throw error
    }

    const sessionDir = this.runtime.session.sessionManager.getSessionDir()
    mkdirSync(sessionDir, { recursive: true })
    const stagedPath = path.join(sessionDir, `piui-import-${randomUUID()}.jsonl`)
    copyFileSync(sourcePath, stagedPath, constants.COPYFILE_EXCL)
    let keepStagedFile = false
    try {
      const result = await this.runtime.importFromJsonl(stagedPath, cwdOverride)
      keepStagedFile = !result.cancelled
      if (!result.cancelled) this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
      this.emitState()
      return {
        sourceSessionId,
        targetSessionId: this.getSessionId(),
        targetSessionFile: this.getSessionFile(),
        targetCwd: this.runtime.cwd,
        cancelled: result.cancelled,
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

  abortCompaction(): void {
    this.runtime.session.abortCompaction?.()
    this.emitState()
  }

  abortBranchSummary(): void {
    this.runtime.session.abortBranchSummary()
    this.emitState()
  }

  abortRetry(): void {
    this.runtime.session.abortRetry()
    this.emitState()
  }

  setAutoCompaction(enabled: boolean): void {
    this.runtime.session.setAutoCompactionEnabled(enabled)
    this.emitState()
  }

  setAutoRetry(enabled: boolean): void {
    this.runtime.session.setAutoRetryEnabled(enabled)
    this.emitState()
  }

  setQueueModes(modes: {
    steeringMode?: QueueDeliveryModeV1
    followUpMode?: QueueDeliveryModeV1
  }): void {
    if (modes.steeringMode) this.runtime.session.setSteeringMode(modes.steeringMode)
    if (modes.followUpMode) this.runtime.session.setFollowUpMode(modes.followUpMode)
    this.emitState()
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const cleared = this.runtime.session.clearQueue()
    this.emitState()
    return cleared
  }

  setActiveTools(toolNames: string[]): void {
    const available = new Set(this.runtime.session.getAllTools().map(tool => tool.name))
    const normalized = [...new Set(toolNames)]
    const unknown = normalized.filter(name => !available.has(name))
    if (unknown.length > 0) {
      throw Object.assign(new Error(`Unknown Pi tools: ${unknown.join(", ")}`), { code: "INVALID_REQUEST" })
    }
    this.runtime.session.setActiveToolsByName(normalized)
    this.emitState()
  }

  async cycleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
    const result = await this.runtime.session.cycleModel(direction)
    if (!result) throw Object.assign(new Error("no authenticated model is available to cycle to"), {
      code: "MODEL_NOT_AVAILABLE",
    })
    this.emitState()
  }

  async setScopedModels(patterns: string[]): Promise<Array<{ message: string; pattern: string }>> {
    const normalized = patterns.map(pattern => pattern.trim()).filter(Boolean)
    const result = await resolveModelScopeWithDiagnostics(normalized, this.runtime.session.modelRuntime)
    this.runtime.session.setScopedModels(result.scopedModels)
    this.emitState()
    return result.diagnostics.map(diagnostic => ({ message: diagnostic.message, pattern: diagnostic.pattern }))
  }

  async listAvailableModels(): Promise<PiModelInfo[]> {
    return (await this.runtime.session.modelRuntime.getAvailable()).map(modelInfo)
  }

  async sendCustomMessage(
    customType: string,
    content: CustomMessageContentV1[],
    options: {
      display: boolean
      details?: unknown
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
    this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
    this.emitProjection()
    this.emitState()
  }

  appendCustomEntry(customType: string, data?: unknown): void {
    const normalized = customType.trim()
    if (!normalized) throw Object.assign(new Error("custom entry type required"), { code: "INVALID_REQUEST" })
    this.runtime.session.sessionManager.appendCustomEntry(normalized, data)
    this.emitState()
  }

  waitForIdle(): Promise<void> {
    return this.runtime.session.waitForIdle()
  }

  getToolDefinition(toolName: string): unknown {
    return toJsonValue(this.runtime.session.getToolDefinition(toolName))
  }

  hasExtensionHandlers(eventType: string): boolean {
    return this.runtime.session.hasExtensionHandlers(eventType as never)
  }

  getSystemPrompt(): string {
    return this.runtime.session.systemPrompt
  }

  getModelRuntime(): ModelRuntime {
    return this.runtime.session.modelRuntime
  }

  inspectRuntime(): PiRuntimeInspectionV1 {
    const session = this.runtime.session
    const manager = session.sessionManager
    return {
      header: toJsonValue(manager.getHeader()),
      entries: toJsonValue(manager.getEntries()) as unknown[],
      branch: toJsonValue(manager.getBranch()) as unknown[],
      contextEntries: toJsonValue(manager.buildContextEntries()) as unknown[],
      context: toJsonValue(manager.buildSessionContext()),
      agentMessages: toJsonValue(session.agent.state.messages) as unknown[],
      lastAssistantText: session.getLastAssistantText(),
      userMessagesForForking: toJsonValue(session.getUserMessagesForForking()) as unknown[],
    }
  }

  inspectResources(): PiResourceSnapshotV1 {
    const loader = this.runtime.session.resourceLoader
    const extensions = loader.getExtensions()
    const skills = loader.getSkills()
    const prompts = loader.getPrompts()
    const themes = loader.getThemes()
    return {
      extensions: extensions.extensions.map(extension => ({
        path: extension.path,
        resolvedPath: extension.resolvedPath,
        hidden: extension.hidden,
        sourceInfo: toJsonValue(extension.sourceInfo),
      })),
      extensionErrors: extensions.errors.map(error => ({ ...error })),
      skills: skills.skills.map(skill => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        disableModelInvocation: skill.disableModelInvocation,
        sourceInfo: toJsonValue(skill.sourceInfo),
      })),
      prompts: prompts.prompts.map(prompt => ({
        name: prompt.name,
        description: prompt.description,
        argumentHint: prompt.argumentHint,
        content: prompt.content,
        filePath: prompt.filePath,
        sourceInfo: toJsonValue(prompt.sourceInfo),
      })),
      themes: themes.themes.map(theme => ({
        name: theme.name,
        sourcePath: theme.sourcePath,
        sourceInfo: toJsonValue(theme.sourceInfo),
      })),
      agentsFiles: loader.getAgentsFiles().agentsFiles.map(file => ({ ...file })),
      systemPrompt: loader.getSystemPrompt(),
      appendSystemPrompt: [...loader.getAppendSystemPrompt()],
      diagnostics: [...skills.diagnostics, ...prompts.diagnostics, ...themes.diagnostics].map(diagnostic => ({
        type: diagnostic.type,
        message: diagnostic.message,
        path: diagnostic.path,
        collision: toJsonValue(diagnostic.collision),
      })),
      runtimeDiagnostics: this.runtime.diagnostics.map(diagnostic => ({ ...diagnostic })),
      modelFallbackMessage: this.runtime.modelFallbackMessage,
    }
  }

  extendResources(paths: PiResourceExtensionPathsV1): void {
    this.runtime.session.resourceLoader.extendResources(paths)
    for (const listener of this.resourceListeners) listener()
  }

  async executeBash(command: string, excludeFromContext = false): Promise<PiBashResult> {
    const normalized = command.trim()
    if (!normalized) throw Object.assign(new Error("empty bash command"), { code: "INVALID_REQUEST" })
    try {
      const eventResult = await this.runtime.session.extensionRunner?.emitUserBash({
        type: "user_bash",
        command: normalized,
        excludeFromContext,
        cwd: this.runtime.session.sessionManager.getCwd(),
      })
      if (eventResult?.result) {
        this.runtime.session.recordBashResult(normalized, eventResult.result, { excludeFromContext })
        return eventResult.result
      }
      return await this.runtime.session.executeBash(normalized, undefined, {
        excludeFromContext,
        operations: eventResult?.operations,
      })
    } finally {
      this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
      this.emitProjection()
      this.emitState()
    }
  }

  abortBash(): void {
    this.runtime.session.abortBash()
    this.emitState()
  }

  exportHtml(outputPath: string): Promise<string> {
    return this.runtime.session.exportToHtml(outputPath)
  }

  exportJsonl(outputPath: string): string {
    return this.runtime.session.exportToJsonl(outputPath)
  }

  async reload(): Promise<void> {
    this.extensionUi.cancelAll("runtime_reloaded")
    await this.runtime.session.reload()
    this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
    this.emitProjection()
    this.emitState()
    for (const listener of this.resourceListeners) listener()
  }

  async steer(text: string, images?: PiImageInput[]): Promise<void> {
    if (!this.runtime.session.isStreaming) {
      throw Object.assign(new Error("Cannot steer an idle Pi session"), { code: "SESSION_NOT_RUNNING" })
    }
    this.assertImageSupport(images)
    await this.runtime.session.steer(text, images)
    this.emitState()
  }

  async followUp(text: string, images?: PiImageInput[]): Promise<void> {
    if (!this.runtime.session.isStreaming) {
      throw Object.assign(new Error("Cannot queue a follow-up on an idle Pi session"), { code: "SESSION_NOT_RUNNING" })
    }
    this.assertImageSupport(images)
    await this.runtime.session.followUp(text, images)
    this.emitState()
  }

  async prompt(text: string, images?: PiImageInput[]): Promise<void> {
    try {
      this.assertImageSupport(images)
      await this.runtime.session.prompt(text, images?.length ? { images } : undefined)
    } finally {
      this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
      this.emitProjection()
      this.emitState()
    }
  }

  private assertImageSupport(images: PiImageInput[] | undefined): void {
    if (!images?.length) return
    const model = this.runtime.session.model as { input?: string[] } | undefined
    if (!model?.input?.includes("image")) {
      throw Object.assign(new Error("The selected Pi model does not support image input"), {
        code: "CAPABILITY_DISABLED",
      })
    }
  }

  async abort(): Promise<{ steering: string[]; followUp: string[] }> {
    const cleared = this.runtime.session.clearQueue()
    await this.runtime.session.abort()
    this.emitState()
    return cleared
  }

  listSkills(): PiSkillInfo[] {
    try {
      const loader = this.runtime.session.resourceLoader as unknown as {
        skills?: Array<{ name: string; description?: string; source?: string }>
        getSkills?: () =>
          | Array<{ name: string; description?: string }>
          | { skills: Array<{ name: string; description?: string; source?: string }> }
      }
      const raw = loader.getSkills?.() ?? loader.skills ?? []
      const skills = Array.isArray(raw) ? raw : (raw.skills ?? [])
      return skills.map(s => ({
        name: s.name,
        description: s.description,
        source: (s as { source?: string }).source,
      }))
    } catch {
      return []
    }
  }

  listCommands(): PiCommandInfo[] {
    const out: PiCommandInfo[] = []
    const runner = this.runtime.session.extensionRunner
    if (runner) {
      for (const command of runner.getRegisteredCommands()) {
        out.push({
          name: command.invocationName,
          description: command.description,
          source: "extension",
        })
      }
    }
    for (const template of this.runtime.session.promptTemplates) {
      out.push({
        name: template.name,
        description: template.description,
        source: "prompt",
      })
    }
    for (const skill of this.listSkills()) {
      out.push({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill",
      })
    }
    return out
  }

  async dispose(): Promise<void> {
    this.extensionUi.cancelAll("runtime_disposed")
    this.detachSessionSubscriptions()
    this.stateListeners.clear()
    this.projectionListeners.clear()
    this.projectionDeltaListeners.clear()
    this.nativeEventListeners.clear()
    this.resourceListeners.clear()
    await this.runtime.dispose()
  }

  _setLastUser(id: string) {
    this.lastUserId = id
  }
  _getLastUser() {
    return this.lastUserId
  }
  _setAsst(id: string | null) {
    this.currentAsstId = id
  }
  _getAsst() {
    return this.currentAsstId
  }
}

function mapSessionEntry(entry: SessionEntry): PiSessionEntryV1 {
  const base = { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, native: toJsonValue(entry) }
  switch (entry.type) {
    case "message": {
      const message = entry.message as unknown as Record<string, unknown>
      return {
        ...base,
        type: "message",
        role: messageRole(message.role),
        preview: previewText(extractText(message.content ?? message.result ?? message.summary)),
      }
    }
    case "thinking_level_change":
      return { ...base, type: entry.type, thinkingLevel: entry.thinkingLevel }
    case "model_change":
      return { ...base, type: entry.type, provider: entry.provider, modelId: entry.modelId }
    case "compaction":
      return {
        ...base,
        type: entry.type,
        summary: entry.summary,
        firstKeptEntryId: entry.firstKeptEntryId,
        tokensBefore: entry.tokensBefore,
      }
    case "branch_summary":
      return { ...base, type: entry.type, fromId: entry.fromId, summary: entry.summary }
    case "custom":
      return { ...base, type: entry.type, customType: entry.customType }
    case "custom_message":
      return {
        ...base,
        type: entry.type,
        customType: entry.customType,
        preview: previewText(extractText(entry.content)),
        display: entry.display,
      }
    case "label":
      return { ...base, type: entry.type, targetId: entry.targetId, label: entry.label }
    case "session_info":
      return { ...base, type: entry.type, name: entry.name }
  }
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString()
    if (typeof item === "function" || typeof item === "symbol") return undefined
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack }
    return item
  }))
}

function mapSessionTree(nodes: SessionTreeNode[]): PiSessionTreeNodeV1[] {
  const roots: PiSessionTreeNodeV1[] = nodes.map(node => ({
    entry: mapSessionEntry(node.entry),
    children: [] as PiSessionTreeNodeV1[],
    label: node.label,
    labelTimestamp: node.labelTimestamp,
  }))
  const stack = nodes.map((source, index) => ({ source, target: roots[index] }))
  while (stack.length > 0) {
    const current = stack.pop()!
    current.target.children = current.source.children.map(child => ({
      entry: mapSessionEntry(child.entry),
      children: [],
      label: child.label,
      labelTimestamp: child.labelTimestamp,
    }))
    current.source.children.forEach((child, index) => {
      stack.push({ source: child, target: current.target.children[index] })
    })
  }
  return roots
}

function messageRole(value: unknown): Extract<PiSessionEntryV1, { type: "message" }>["role"] {
  if (
    value === "user" || value === "assistant" || value === "toolResult" || value === "bashExecution" ||
    value === "branchSummary" || value === "compactionSummary" || value === "custom"
  ) return value
  return "custom"
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized
}

function resolveUserPath(input: string): string {
  const trimmed = input.trim()
  if (/^file:\/\//i.test(trimmed)) return path.resolve(fileURLToPath(trimmed))
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/") || (process.platform === "win32" && trimmed.startsWith("~\\"))) {
    return path.resolve(homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

function sessionInfo(info: {
  id: string
  path: string
  cwd: string
  name?: string
  created: Date
  modified: Date
  messageCount: number
  firstMessage: string
}): PiSessionInfo {
  return {
    id: info.id,
    path: info.path,
    cwd: info.cwd,
    name: info.name,
    createdAt: info.created.toISOString(),
    updatedAt: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage,
  }
}

function pathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function modelInfo(model: {
  id: string
  name?: string
  provider: string
  family?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: string[]
}): PiModelInfo {
  return {
    id: model.id,
    name: model.name || model.id,
    providerId: model.provider,
    family: model.family || "",
    contextLimit: model.contextWindow ?? 0,
    outputLimit: model.maxTokens ?? 0,
    supportsReasoning: Boolean(model.reasoning),
    thinkingLevels: supportedThinkingLevels(model),
    supportsImages: Array.isArray(model.input) && model.input.includes("image"),
  }
}

function supportedThinkingLevels(model: {
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<string, unknown | null>>
}): string[] {
  if (!model.reasoning) return ["off"]
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter(level => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    return level !== "xhigh" && level !== "max" || mapped !== undefined
  })
}

function mapCompactionResult(result: {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  estimatedTokensAfter?: number
}): CompactionResultV1 {
  return {
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: result.tokensBefore,
    estimatedTokensAfter: result.estimatedTokensAfter,
  }
}

function isRuntimeStateEvent(type: string): boolean {
  return type === "agent_start" ||
    type === "agent_end" ||
    type === "agent_settled" ||
    type === "queue_update" ||
    type === "thinking_level_changed" ||
    type === "session_info_changed" ||
    type === "compaction_start" ||
    type === "compaction_end" ||
    type === "auto_retry_start" ||
    type === "auto_retry_end" ||
    type === "summarization_retry_scheduled" ||
    type === "summarization_retry_attempt_start" ||
    type === "summarization_retry_finished"
}

function toolSource(sourceInfo: unknown): string | undefined {
  if (typeof sourceInfo === "string") return sourceInfo
  if (!sourceInfo || typeof sourceInfo !== "object") return undefined
  const source = sourceInfo as Record<string, unknown>
  if (typeof source.type === "string") return source.type
  if (typeof source.path === "string") return source.path
  return undefined
}

function projectNativeBranch(entries: SessionEntry[]): ProjectionState {
  const projected: PiEntry[] = []
  for (const entry of entries) {
    if (entry.type !== "message") continue
    const message = entry.message as unknown as Record<string, unknown>
    const role = message.role
    const messageTimestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp)
    const timestamp = Number.isFinite(messageTimestamp) ? messageTimestamp : 0
    if (role === "user") {
      projected.push({
        type: "message",
        id: entry.id,
        parentId: entry.parentId,
        timestamp,
        message: { role: "user", content: extractText(message.content) },
      })
    } else if (role === "assistant") {
      projected.push({
        type: "message",
        id: entry.id,
        parentId: entry.parentId,
        timestamp,
        message: {
          role: "assistant",
          content: toContentBlocks(message.content),
          provider: typeof message.provider === "string" ? message.provider : undefined,
          model: typeof message.model === "string" ? message.model : undefined,
          stopReason: isStopReason(message.stopReason) ? message.stopReason : undefined,
          errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
        },
      })
    } else if (role === "toolResult") {
      projected.push({
        type: "message",
        id: entry.id,
        parentId: entry.parentId,
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: String(message.toolCallId ?? ""),
          toolName: typeof message.toolName === "string" ? message.toolName : undefined,
          isError: Boolean(message.isError),
          result: toResultBlocks(message.content),
          details: message.details,
        },
      })
    }
  }
  return projectEntries(projected)
}

function isStopReason(value: unknown): value is "stop" | "length" | "toolUse" | "error" | "aborted" {
  return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted"
}

function mapPiEventToWorker(event: { type: string; [k: string]: unknown }, ctx: RealPiSession): WorkerEvent[] {
  const out: WorkerEvent[] = []
  const now = Date.now()

  if (event.type === "message_start") {
    const message = event.message as { role?: string; content?: unknown } | undefined
    const role = message?.role
    if (role === "user") {
      const id = `u-${now}-${Math.random().toString(36).slice(2, 7)}`
      ctx._setLastUser(id)
      out.push({ type: "message_start", entryId: id, role: "user", timestamp: now })
      const text = extractText(message?.content)
      out.push({
        type: "message_end",
        entryId: id,
        role: "user",
        parentId: null,
        timestamp: now,
        message: { role: "user", content: text },
      })
    } else if (role === "assistant") {
      const id = `a-${now}-${Math.random().toString(36).slice(2, 7)}`
      ctx._setAsst(id)
      out.push({ type: "message_start", entryId: id, role: "assistant", timestamp: now })
    }
    return out
  }

  if (event.type === "message_update") {
    const asstId = ctx._getAsst()
    if (!asstId) return out
    const message = event.message as { content?: unknown } | undefined
    // prefer delta path: full content rebuild from message
    const blocks = toContentBlocks(message?.content)
    out.push({ type: "message_update", entryId: asstId, content: blocks })
    return out
  }

  if (event.type === "message_end") {
    const message = event.message as { role?: string; content?: unknown } | undefined
    if (message?.role === "assistant") {
      const asstId = ctx._getAsst() ?? `a-${now}`
      const blocks = toContentBlocks(message.content)
      out.push({
        type: "message_end",
        entryId: asstId,
        role: "assistant",
        parentId: ctx._getLastUser(),
        timestamp: now,
        message: { role: "assistant", content: blocks },
      })
      ctx._setAsst(null)
    } else if (message?.role === "toolResult") {
      const m = message as {
        toolCallId?: string
        isError?: boolean
        content?: unknown
        result?: unknown
      }
      const toolCallId = m.toolCallId ?? ""
      const result = toResultBlocks(m.content ?? m.result)
      out.push({
        type: "tool_execution_end",
        toolCallId,
        isError: m.isError,
        result,
        details: (message as Record<string, unknown>).details,
      })
      out.push({
        type: "message_end",
        entryId: `tr-${now}`,
        role: "toolResult",
        parentId: ctx._getAsst(),
        timestamp: now,
        message: {
          role: "toolResult",
          toolCallId,
          isError: m.isError,
          result,
          details: (message as Record<string, unknown>).details,
        },
      })
    }
    return out
  }

  if (event.type === "tool_execution_start") {
    out.push({
      type: "tool_execution_start",
      toolCallId: String(event.toolCallId ?? ""),
      toolName: String(event.toolName ?? "tool"),
      args: event.args,
    })
    return out
  }

  if (event.type === "tool_execution_end") {
    out.push({
      type: "tool_execution_end",
      toolCallId: String(event.toolCallId ?? ""),
      isError: Boolean(event.isError),
      result: toResultBlocks((event.result as { content?: unknown } | undefined)?.content ?? event.result),
      details: (event.result as { details?: unknown } | undefined)?.details,
    })
    return out
  }

  if (event.type === "tool_execution_update") {
    const partial = event.partialResult as { content?: unknown; details?: unknown } | undefined
    out.push({
      type: "tool_execution_update",
      toolCallId: String(event.toolCallId ?? ""),
      result: toResultBlocks(partial?.content),
      details: partial?.details,
    })
    return out
  }

  if (event.type === "agent_end" || event.type === "agent_settled") {
    out.push({ type: "agent_end" })
  }

  return out
}

function extractText(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map(b => {
        if (!b || typeof b !== "object") return ""
        const o = b as Record<string, unknown>
        if (o.type === "text" && typeof o.text === "string") return o.text
        if (typeof o.text === "string") return o.text
        return ""
      })
      .join("")
  }
  return String(content)
}

function toContentBlocks(content: unknown): PiContentBlock[] {
  if (content == null) return []
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }]
  const blocks: PiContentBlock[] = []
  for (const b of content) {
    if (!b || typeof b !== "object") continue
    const o = b as Record<string, unknown>
    if (o.type === "text" && typeof o.text === "string") {
      blocks.push({ type: "text", text: o.text })
    } else if (o.type === "thinking" || o.type === "reasoning") {
      const t = typeof o.thinking === "string" ? o.thinking : typeof o.text === "string" ? o.text : ""
      blocks.push({ type: "thinking", thinking: t })
    } else if (o.type === "toolCall" || o.type === "tool_use") {
      blocks.push({
        type: "toolCall",
        id: String(o.id ?? o.toolCallId ?? `tc-${Date.now()}`),
        name: String(o.name ?? o.toolName ?? "tool"),
        arguments: o.arguments ?? o.input ?? {},
      })
    }
  }
  return blocks
}

function toResultBlocks(content: unknown): Array<
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
> {
  if (content == null) return []
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }]
  const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const value = block as Record<string, unknown>
    if (value.type === "text" && typeof value.text === "string") {
      blocks.push({ type: "text", text: value.text })
    } else if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
      blocks.push({ type: "image", data: value.data, mimeType: value.mimeType })
    }
  }
  return blocks
}
