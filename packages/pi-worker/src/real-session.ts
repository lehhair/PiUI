/**
 * Real Pi AgentSessionRuntime wrapper.
 * Only used when PIUI_DRIVER=pi. Will call configured models.
 */
import {
  applyHttpProxySettings,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultPackageManager,
  getAgentDir,
  ModelRuntime,
  ProjectTrustStore,
  resolveProjectTrusted,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
  hasTrustRequiringProjectResources,
  type ProjectTrustContext,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent"
import { PI_PARITY_SDK_VERSION } from "@piui/protocol"
import type {
  CompactionCommandResultV1,
  CompactionResultV1,
  CompactionStateV1,
  PiNativeJsonValueV1,
  PiNativeSessionEnvelopeV1,
  PiToolInfoV1,
  PiSettingsPatchV1,
  PiSettingsSnapshotV1,
  PiPackageSourceV1,
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
import type { PiBashResult, PiImageInput, PiModelInfo } from "./worker-protocol.js"
import { ExtensionUiBridge, type PiExtensionUiEvent } from "./extension-ui-bridge.js"
import {
  nativeEntriesPageFromEntries,
  nativeImageAttachmentFromEntry,
  nativeSessionHeadFromParts,
} from "./native-pagination.js"

export interface PiRuntimeUiState {
  thinkingLevel: string
  availableThinkingLevels: string[]
  isStreaming: boolean
  isCompacting: boolean
  isIdle: boolean
  isBashRunning: boolean
  hasPendingBashMessages: boolean
  isRetrying: boolean
  retryAttempt: number
  pendingMessageCount: number
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
  description: string
  filePath: string
  baseDir: string
  sourceInfo: unknown
  disableModelInvocation: boolean
}

export interface PiCommandInfo {
  name: string
  description?: string
  source: "skill" | "prompt" | "extension"
  sourceInfo: unknown
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

export interface ExtensionHostActions {
  reserveReplacement(request: {
    reservationId: string
    sourceSessionId: string
    operation: "new" | "fork" | "switch"
    targetSessionFile?: string
  }): Promise<void>
  commitReplacement(reservationId: string, replacement: SessionReplacementResultV1): Promise<void>
  abortReplacement(reservationId: string): Promise<void>
  requestShutdown(sessionId: string): void
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
        runExtensionReplacement(runtime, hostActions, "new", undefined, () =>
        runtime.newSession(options)),
      fork: (entryId: string, options?: Parameters<AgentSessionRuntime["fork"]>[1]) =>
        runExtensionReplacement(runtime, hostActions, "fork", undefined, () => runtime.fork(entryId, options)),
      navigateTree: async (entryId: string, options?: {
        summarize?: boolean
        customInstructions?: string
        replaceInstructions?: boolean
        label?: string
      }) => {
        const result = await navigateTree(entryId, options)
        return { cancelled: result.cancelled }
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
    const replacement: SessionReplacementResultV1 = {
      operation,
      sourceSessionId,
      targetSessionId: runtime.session.sessionManager.getSessionId(),
      targetSessionFile: runtime.session.sessionManager.getSessionFile(),
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

function unsupportedExtensionHostAction(action: string): never {
  throw Object.assign(new Error(`Extension command context ${action} requires a coordinated PiUI host`), {
    code: "CAPABILITY_DISABLED",
  })
}

export interface RealPiSessionOpenOptions {
  agentDir?: string
  createRuntime?: CreateAgentSessionRuntimeFactory
  createSessionManager?: (cwd: string, sessionFile?: string) => SessionManager
  hostActions?: ExtensionHostActions
}

const createDefaultRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
}) => {
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

function settingsForWorkspace(cwd: string, agentDir = getAgentDir()): { manager: SettingsManager; trusted: boolean } {
  const trust = RealPiSession.getProjectTrust(cwd, agentDir)
  return {
    manager: SettingsManager.create(cwd, agentDir, { projectTrusted: trust.trusted }),
    trusted: trust.trusted,
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

function configuredSessionDir(cwd: string, agentDir = getAgentDir()): string | undefined {
  const envSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
  if (envSessionDir) return resolveUserPath(envSessionDir)
  return SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getSessionDir()
}

function packageManagerForWorkspace(cwd: string): DefaultPackageManager {
  const { manager } = settingsForWorkspace(cwd)
  return new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: manager })
}

function settingsSnapshot(cwd: string, manager: SettingsManager, trusted: boolean): PiSettingsSnapshotV1 {
  const global = jsonClone(manager.getGlobalSettings()) as Record<string, unknown>
  const project = jsonClone(manager.getProjectSettings()) as Record<string, unknown>
  return {
    workspacePath: cwd,
    projectTrusted: trusted,
    global,
    project,
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
      httpProxy: manager.getHttpProxy(),
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
    else if (key === "defaultThinkingLevel") manager.setDefaultThinkingLevel(expectEnum(key, value, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]))
    else if (key === "transport") manager.setTransport(expectEnum(key, value, ["auto", "sse", "websocket", "websocket-cached"]))
    else if (key === "steeringMode") manager.setSteeringMode(expectEnum(key, value, ["all", "one-at-a-time"]))
    else if (key === "followUpMode") manager.setFollowUpMode(expectEnum(key, value, ["all", "one-at-a-time"]))
    else if (key === "theme") manager.setTheme(expectString(key, value))
    else if (key === "compactionEnabled") manager.setCompactionEnabled(expectBoolean(key, value))
    else if (key === "retryEnabled") manager.setRetryEnabled(expectBoolean(key, value))
    else if (key === "httpIdleTimeoutMs") manager.setHttpIdleTimeoutMs(expectNonNegativeNumber(key, value))
    else if (key === "httpProxy") manager.setHttpProxy(expectOptionalString(key, value))
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
    else if (key === "packages") manager.setPackages(expectPackageSources(key, value))
    else if (key === "projectPackages") manager.setProjectPackages(expectPackageSources(key, value))
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
    else if (key === "warnings") manager.setWarnings(expectWarnings(key, value))
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

function expectNonNegativeNumber(key: string, value: unknown): number {
  const result = expectNumber(key, value)
  if (result < 0) throw invalidSetting(key)
  return result
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

function expectPackageSources(key: string, value: unknown): PiPackageSourceV1[] {
  if (!Array.isArray(value)) throw invalidSetting(key)
  for (const item of value) {
    if (typeof item === "string") continue
    const source = expectRecord(key, item)
    if (typeof source.source !== "string" || !source.source) throw invalidSetting(key)
    if (source.autoload !== undefined && typeof source.autoload !== "boolean") throw invalidSetting(key)
    for (const field of ["extensions", "skills", "prompts", "themes"] as const) {
      if (source[field] !== undefined) expectStringArray(key, source[field])
    }
    if (Object.keys(source).some(field => !["source", "autoload", "extensions", "skills", "prompts", "themes"].includes(field))) {
      throw invalidSetting(key)
    }
  }
  return value as PiPackageSourceV1[]
}

function expectWarnings(key: string, value: unknown): { anthropicExtraUsage?: boolean } {
  const warnings = expectRecord(key, value)
  if (Object.keys(warnings).some(field => field !== "anthropicExtraUsage")) throw invalidSetting(key)
  if (warnings.anthropicExtraUsage !== undefined && typeof warnings.anthropicExtraUsage !== "boolean") {
    throw invalidSetting(key)
  }
  return warnings as { anthropicExtraUsage?: boolean }
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
  private stateUnsub: (() => void) | null = null
  private stateListeners = new Set<(s: PiRuntimeUiState) => void>()
  private nativeEventListeners = new Set<(event: PiNativeJsonValueV1) => void>()
  private nativeHeadListeners = new Set<(native: import("@piui/protocol").PiNativeSessionHeadV1) => void>()
  private nativeRevision = 1
  private nativeFingerprint = ""
  private resourceListeners = new Set<() => void>()
  /** last known runtime flags from events */
  private isCompactingFlag = false
  private retryState: RetryStateV1 = { phase: "idle", autoEnabled: true }
  private compactionState: CompactionStateV1 = {
    autoEnabled: true,
    operation: { type: "none" },
  }

  private constructor(runtime: AgentSessionRuntime, private readonly hostActions?: ExtensionHostActions) {
    this.runtime = runtime
    this.extensionUi = new ExtensionUiBridge(
      () => this.runtime.session.sessionManager.getSessionId(),
      () => undefined,
      () => this.runtime.session.resourceLoader.getThemes().themes.flatMap(theme =>
        theme.name ? [{ name: theme.name, path: theme.sourcePath }] : []),
    )
    this.nativeFingerprint = this.getNativeFingerprint()
    this.bindStateEvents()
  }

  private bindStateEvents(): void {
    this.stateUnsub?.()
    this.stateUnsub = this.runtime.session.subscribe(event => {
      const nativeEvent = toNativeJsonValue(event)
      if (nativeEvent === undefined) {
        throw Object.assign(new Error("Pi native event is not JSON serializable"), { code: "NATIVE_EVENT_NOT_JSON" })
      }
      for (const listener of this.nativeEventListeners) listener(nativeEvent)
      this.emitNativeEnvelopeIfChanged()

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
          this.emitNativeEnvelopeIfChanged()
          this.emitState()
        })
      }
    })
  }

  private detachSessionSubscriptions(): void {
    this.stateUnsub?.()
    this.stateUnsub = null
  }

  /** Shadow state tracks one session; a replacement must not inherit it. */
  private resetSessionShadowState(): void {
    this.isCompactingFlag = false
    this.retryState = { phase: "idle", autoEnabled: this.runtime.session.autoRetryEnabled }
    this.compactionState = {
      autoEnabled: this.runtime.session.autoCompactionEnabled,
      operation: { type: "none" },
    }
  }

  static async open(
    cwd: string,
    sessionFile?: string,
    options: RealPiSessionOpenOptions = {},
  ): Promise<RealPiSession> {
    if (sessionFile && !existsSync(sessionFile)) {
      throw Object.assign(new Error("Pi session file no longer exists"), { code: "SESSION_FILE_NOT_FOUND" })
    }
    const agentDir = options.agentDir ?? getAgentDir()
    const sessionDir = configuredSessionDir(cwd, agentDir)
    const sessionManager = options.createSessionManager?.(cwd, sessionFile) ??
      (sessionFile
        ? sessionDir ? SessionManager.open(sessionFile, sessionDir) : SessionManager.open(sessionFile)
        : SessionManager.create(cwd, sessionDir))
    if (sessionFile && pathKey(sessionManager.getCwd()) !== pathKey(cwd)) {
      throw Object.assign(new Error("Pi session workspace does not match the selected workspace"), {
        code: "SESSION_WORKSPACE_MISMATCH",
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
      result.bindStateEvents()
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

  onExtensionUi(listener: (event: PiExtensionUiEvent) => void): () => void {
    return this.extensionUi.onEvent(listener)
  }

  respondExtensionUi(requestId: string, response: import("@piui/protocol").ExtensionUiDialogResponseV1): boolean {
    return this.extensionUi.respond(requestId, response)
  }

  setExtensionEditorState(text: string): void {
    this.extensionUi.setEditorState(text)
  }

  static async list(cwd: string, agentDir = getAgentDir()): Promise<PiSessionInfo[]> {
    return (await SessionManager.list(cwd, configuredSessionDir(cwd, agentDir))).map(sessionInfo)
  }

  static async listAll(agentDir = getAgentDir()): Promise<PiSessionInfo[]> {
    return (await SessionManager.listAll(configuredSessionDir(process.cwd(), agentDir))).map(sessionInfo)
  }

  static async listModels(): Promise<PiModelInfo[]> {
    const runtime = await ModelRuntime.create({ allowModelNetwork: false })
    return jsonClone(await runtime.getAvailable()) as PiModelInfo[]
  }

  static getSettings(cwd: string, agentDir = getAgentDir()): PiSettingsSnapshotV1 {
    const { manager, trusted } = settingsForWorkspace(cwd, agentDir)
    return settingsSnapshot(cwd, manager, trusted)
  }

  static async patchSettings(
    cwd: string,
    patch: PiSettingsPatchV1,
    agentDir = getAgentDir(),
  ): Promise<PiSettingsSnapshotV1> {
    const { manager, trusted } = settingsForWorkspace(cwd, agentDir)
    applySettingsPatch(manager, patch)
    await manager.flush()
    if ("httpProxy" in patch) applyHttpProxySettings(manager.getHttpProxy())
    return settingsSnapshot(cwd, manager, trusted)
  }

  static getProjectTrust(cwd: string, agentDir = getAgentDir()): ProjectTrustV1 {
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
    missingAction: "install" | "skip" | "error" = "skip",
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

  onNativeEvent(listener: (event: PiNativeJsonValueV1) => void): () => void {
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

  getSessionId(): string {
    return this.runtime.session.sessionId
  }

  getSessionFile(): string | undefined {
    return this.runtime.session.sessionFile
  }

  getSessionName(): string | undefined {
    return this.runtime.session.sessionManager.getSessionName()
  }

  getLeafId(): string | null {
    return this.runtime.session.sessionManager.getLeafId()
  }

  onNativeHead(listener: (native: import("@piui/protocol").PiNativeSessionHeadV1) => void): () => void {
    this.nativeHeadListeners.add(listener)
    return () => this.nativeHeadListeners.delete(listener)
  }

  getNativeEnvelope(): PiNativeSessionEnvelopeV1 {
    const manager = this.runtime.session.sessionManager
    const header = toNativeJsonValue(manager.getHeader())
    const entries = toNativeJsonValue(manager.getEntries())
    if (!Array.isArray(entries) || entries.some(entry => !isNativeJsonObject(entry))) {
      throw Object.assign(new Error("Pi session entries are not JSON objects"), { code: "NATIVE_SESSION_NOT_JSON" })
    }
    const nativeEntries = entries.filter(isNativeJsonObject)
    const tree = toNativeJsonValue(manager.getTree())
    if (!Array.isArray(tree) || tree.some(node => !isNativeJsonObject(node))) {
      throw Object.assign(new Error("Pi session tree nodes are not JSON objects"), { code: "NATIVE_SESSION_NOT_JSON" })
    }
    const version = isNativeJsonObject(header) && typeof header.version === "number" ? header.version : undefined
    return {
      namespace: "pi",
      schemaVersion: 1,
      sdkVersion: PI_PARITY_SDK_VERSION,
      revision: this.nativeRevision,
      sessionFormatVersion: version,
      header: header ?? null,
      leafId: manager.getLeafId(),
      entries: nativeEntries,
      tree: tree.filter(isNativeJsonObject),
    }
  }

  getNativeHead() {
    const manager = this.runtime.session.sessionManager
    const header = toNativeJsonValue(manager.getHeader()) ?? null
    const version = isNativeJsonObject(header) && typeof header.version === "number" ? header.version : undefined
    return nativeSessionHeadFromParts({
      sdkVersion: PI_PARITY_SDK_VERSION,
      revision: this.nativeRevision,
      sessionFormatVersion: version,
      header,
      leafId: manager.getLeafId(),
      entryCount: manager.getEntries().length,
    }, manager.getSessionId())
  }

  getNativeEntriesPage(cursor: string | undefined, limit: number, maxBytes: number) {
    const manager = this.runtime.session.sessionManager
    return nativeEntriesPageFromEntries(
      this.getNativeHead(),
      manager.getEntries(),
      { cursor, limit, maxBytes },
      toNativeJsonObject,
    )
  }

  getNativeBranchPage(cursor: string | undefined, limit: number, maxBytes: number) {
    const manager = this.runtime.session.sessionManager
    return nativeEntriesPageFromEntries(
      this.getNativeHead(),
      manager.getBranch(),
      { cursor, limit, maxBytes },
      toNativeJsonObject,
    )
  }

  getNativeTree(): Array<{ [key: string]: PiNativeJsonValueV1 }> {
    const tree = toNativeJsonValue(this.runtime.session.sessionManager.getTree())
    if (!Array.isArray(tree) || tree.some(node => !isNativeJsonObject(node))) {
      throw Object.assign(new Error("Pi session tree nodes are not JSON objects"), { code: "NATIVE_SESSION_NOT_JSON" })
    }
    return tree.filter(isNativeJsonObject)
  }

  getNativeImageAttachment(entryId: string, blockIndex: number) {
    const entry = this.runtime.session.sessionManager.getEntry(entryId)
    if (!entry) throw Object.assign(new Error("native entry not found"), { code: "NOT_FOUND" })
    return nativeImageAttachmentFromEntry(toNativeJsonObject(entry), blockIndex)
  }

  private getNativeFingerprint(): string {
    const manager = this.runtime.session.sessionManager
    const entries = manager.getEntries()
    const last = entries.at(-1)
    return `${entries.length}:${manager.getLeafId() ?? ""}:${last?.id ?? ""}:${last?.timestamp ?? ""}`
  }

  private emitNativeEnvelopeIfChanged(): void {
    const fingerprint = this.getNativeFingerprint()
    if (fingerprint === this.nativeFingerprint) return
    this.nativeFingerprint = fingerprint
    this.nativeRevision += 1
    const native = this.getNativeHead()
    for (const listener of this.nativeHeadListeners) listener(native)
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
      isBashRunning: Boolean(session.isBashRunning),
      hasPendingBashMessages: Boolean(session.hasPendingBashMessages),
      isRetrying: Boolean(session.isRetrying),
      retryAttempt: Number(session.retryAttempt ?? 0),
      pendingMessageCount: Number(session.pendingMessageCount ?? 0),
      queue: {
        steering,
        followUp,
        steeringMode: session.steeringMode,
        followUpMode: session.followUpMode,
      },
      retry: { ...this.retryState, autoEnabled: session.autoRetryEnabled },
      compaction: { ...this.compactionState, autoEnabled: session.autoCompactionEnabled },
      tools: jsonClone(session.getAllTools()),
      activeTools: session.getActiveToolNames?.() ?? [],
      model: this.getModel(),
      supportsThinking: Boolean(session.supportsThinking?.() ?? true),
      contextUsage: contextUsage ? {
        contextTokens: contextUsage.tokens,
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
      this.emitNativeEnvelopeIfChanged()
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
    summaryEntry?: { [key: string]: PiNativeJsonValueV1 }
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
      this.emitNativeEnvelopeIfChanged()
      this.emitState()
    }
    return {
      editorText: result.editorText,
      cancelled: result.cancelled,
      aborted: result.aborted,
      summaryEntry: result.summaryEntry ? toNativeJsonObject(result.summaryEntry) : undefined,
    }
  }

  setLabel(entryId: string, label?: string): void {
    this.runtime.session.sessionManager.appendLabelChange(entryId, label)
    this.emitNativeEnvelopeIfChanged()
    this.emitState()
  }

  setSessionName(name: string): void {
    this.runtime.session.setSessionName(name)
    this.emitNativeEnvelopeIfChanged()
    this.emitState()
  }

  async fork(entryId: string, position: "before" | "at"): Promise<SessionReplacementResultV1> {
    await this.runtime.session.waitForIdle()
    const sourceSessionId = this.getSessionId()
    const result = await this.runtime.fork(entryId, { position })
    if (!result.cancelled) this.emitNativeEnvelopeIfChanged()
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
    if (!result.cancelled) this.emitNativeEnvelopeIfChanged()
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
    if (!result.cancelled) this.emitNativeEnvelopeIfChanged()
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
      if (!result.cancelled) this.emitNativeEnvelopeIfChanged()
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
    return jsonClone(await this.runtime.session.modelRuntime.getAvailable()) as PiModelInfo[]
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
    this.emitNativeEnvelopeIfChanged()
    this.emitState()
  }

  appendCustomEntry(customType: string, data?: unknown): void {
    const normalized = customType.trim()
    if (!normalized) throw Object.assign(new Error("custom entry type required"), { code: "INVALID_REQUEST" })
    this.runtime.session.sessionManager.appendCustomEntry(normalized, data)
    this.emitNativeEnvelopeIfChanged()
    this.emitState()
  }

  cycleThinkingLevel(): string {
    const level = this.runtime.session.cycleThinkingLevel()
    if (level === undefined) {
      throw Object.assign(new Error("the selected Pi model does not support thinking levels"), {
        code: "CAPABILITY_DISABLED",
      })
    }
    this.emitState()
    return String(level)
  }

  async sendUserMessage(
    text: string,
    images?: PiImageInput[],
    deliverAs?: "steer" | "followUp",
  ): Promise<void> {
    this.assertImageSupport(images)
    const content = images?.length
      ? [{ type: "text" as const, text }, ...images]
      : text
    try {
      await this.runtime.session.sendUserMessage(content, deliverAs ? { deliverAs } : undefined)
    } finally {
      this.emitNativeEnvelopeIfChanged()
      this.emitState()
    }
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
      native: this.getNativeEnvelope(),
      branch: toNativeJsonArray(manager.getBranch()),
      contextEntries: toNativeJsonArray(manager.buildContextEntries()),
      context: toNativeJsonValue(manager.buildSessionContext()) ?? null,
      agentMessages: toNativeJsonArray(session.agent.state.messages),
      lastAssistantText: session.getLastAssistantText(),
      userMessagesForForking: toNativeJsonArray(session.getUserMessagesForForking()),
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
      this.emitNativeEnvelopeIfChanged()
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
    this.nativeFingerprint = ""
    this.emitNativeEnvelopeIfChanged()
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

  async prompt(
    text: string,
    images?: PiImageInput[],
    options: { expandPromptTemplates?: boolean } = {},
  ): Promise<void> {
    try {
      this.assertImageSupport(images)
      await this.runtime.session.prompt(text, {
        images: images?.length ? images : undefined,
        expandPromptTemplates: options.expandPromptTemplates,
        source: "rpc",
      })
    } finally {
      this.emitNativeEnvelopeIfChanged()
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
    return jsonClone(this.runtime.session.resourceLoader.getSkills().skills)
  }

  listCommands(): PiCommandInfo[] {
    return jsonClone(this.runtime.session.getCommands())
  }

  async dispose(): Promise<void> {
    this.extensionUi.cancelAll("runtime_disposed")
    this.detachSessionSubscriptions()
    this.stateListeners.clear()
    this.nativeEventListeners.clear()
    this.nativeHeadListeners.clear()
    this.resourceListeners.clear()
    await this.runtime.dispose()
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

function toNativeJsonValue(value: unknown): PiNativeJsonValueV1 | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as PiNativeJsonValueV1
  } catch (cause) {
    throw Object.assign(new Error("Pi native session data is not JSON serializable", { cause }), {
      code: "NATIVE_SESSION_NOT_JSON",
    })
  }
}

function isNativeJsonObject(value: PiNativeJsonValueV1 | undefined): value is { [key: string]: PiNativeJsonValueV1 } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function toNativeJsonObject(value: unknown): { [key: string]: PiNativeJsonValueV1 } {
  const json = toNativeJsonValue(value)
  if (!isNativeJsonObject(json)) {
    throw Object.assign(new Error("Pi native session entry is not a JSON object"), { code: "NATIVE_SESSION_NOT_JSON" })
  }
  return json
}

function toNativeJsonArray(value: unknown): PiNativeJsonValueV1[] {
  const json = toNativeJsonValue(value)
  if (!Array.isArray(json)) {
    throw Object.assign(new Error("Pi native runtime data is not a JSON array"), { code: "NATIVE_SESSION_NOT_JSON" })
  }
  return json
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

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
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
