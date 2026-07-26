import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { isRuntimeControlStateV1, PI_PARITY_SDK_VERSION } from "@piui/protocol"
import type {
  CompactionCommandResultV1,
  ExtensionUiDialogResponseV1,
  PiNavigationResultV1,
  PiSettingsPatchV1,
  PiSettingsSnapshotV1,
  ProjectTrustV1,
  ProviderAuthEventV1,
  ProviderAuthInfoV1,
  ConfiguredPackageV1,
  CustomMessageContentV1,
  PackageProgressV1,
  PiResourceSnapshotV1,
  PiResourceExtensionPathsV1,
  PiRuntimeInspectionV1,
  ResolvedPackageResourcesV1,
  PackageUpdateV1,
  PiModelRuntimeSnapshotV1,
  QueueDeliveryModeV1,
  SessionReplacementResultV1,
} from "@piui/protocol"
import {
  getPiWorkerEntryUrl,
  PI_WORKER_PROTOCOL_VERSION,
  restoreProjection,
  type PiCommandInfo,
  type PiBashResult,
  type PiImageInput,
  type PiExtensionUiEvent,
  type PiModelInfo,
  type PiRuntimeUiState,
  type PiSessionInfo,
  type PiSessionRuntime,
  type PiSkillInfo,
  type PiWorkerCapability,
  type ProjectionDelta,
  type ProjectionState,
  type WorkerCommand,
  type WorkerHello,
  type WorkerMessage,
  type WorkerResult,
  type WorkerSessionWire,
} from "@piui/pi-worker"

interface PendingRequest {
  resolve: (result: WorkerResult) => void
  reject: (error: Error) => void
}

export interface PiWorkerClientOptions {
  handshakeTimeoutMs?: number
  heartbeatTimeoutMs?: number
}

export interface PiWorkerCatalog {
  getHandshake(): Promise<WorkerHello>
  list(cwd: string): Promise<PiSessionInfo[]>
  listAll(): Promise<PiSessionInfo[]>
  listModels(): Promise<PiModelInfo[]>
  getSettings(cwd: string): Promise<PiSettingsSnapshotV1>
  patchSettings(cwd: string, patch: PiSettingsPatchV1): Promise<PiSettingsSnapshotV1>
  getProjectTrust(cwd: string): Promise<ProjectTrustV1>
  setProjectTrust(cwd: string, decision: boolean | null): Promise<ProjectTrustV1>
  listProviders(): Promise<ProviderAuthInfoV1[]>
  startProviderAuth(providerId: string, authType: "api_key" | "oauth"): Promise<string>
  respondProviderAuth(flowId: string, promptId: string, value: string): Promise<void>
  cancelProviderAuth(flowId: string): Promise<void>
  logoutProvider(providerId: string): Promise<void>
  inspectModelRuntime(): Promise<PiModelRuntimeSnapshotV1>
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>
  removeRuntimeApiKey(providerId: string): Promise<void>
  reloadModelRuntime(): Promise<void>
  refreshModelRuntime(options?: Record<string, unknown>): Promise<unknown>
  onProviderAuth(listener: (event: ProviderAuthEventV1) => void): () => void
  listPackages(cwd: string): Promise<ConfiguredPackageV1[]>
  managePackage(
    cwd: string,
    commandId: string,
    action: "install" | "remove" | "update",
    source?: string,
    local?: boolean,
    persist?: boolean,
  ): Promise<ConfiguredPackageV1[]>
  resolvePackages(cwd: string, missingAction?: "skip" | "error"): Promise<ResolvedPackageResourcesV1>
  resolveExtensionSources(
    cwd: string,
    sources: string[],
    options?: { local?: boolean; temporary?: boolean },
  ): Promise<ResolvedPackageResourcesV1>
  changePackageSource(
    cwd: string,
    source: string,
    operation: "add" | "remove",
    local?: boolean,
  ): Promise<{ changed: boolean; packages: ConfiguredPackageV1[] }>
  getInstalledPackagePath(cwd: string, source: string, scope: "user" | "project"): Promise<string | undefined>
  checkPackageUpdates(cwd: string): Promise<PackageUpdateV1[]>
  onPackageProgress(listener: (event: PackageProgressV1) => void): () => void
  onCrash(listener: (error: Error) => void): () => void
  dispose(): Promise<void>
}

export interface PiWorkerHost {
  getHandshake(): Promise<WorkerHello>
  open(cwd: string, sessionFile?: string): Promise<PiWorkerSession>
  dispose(): Promise<void>
}

export class PiWorkerSession implements PiSessionRuntime {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly stateListeners = new Set<(state: PiRuntimeUiState) => void>()
  private readonly projectionListeners = new Set<(projection: ProjectionState) => void>()
  private readonly projectionDeltaListeners = new Set<(projection: ProjectionDelta) => void>()
  private readonly crashListeners = new Set<(error: Error) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly extensionUiListeners = new Set<(event: PiExtensionUiEvent) => void>()
  private readonly nativeEventListeners = new Set<(event: unknown) => void>()
  private readonly resourceListeners = new Set<() => void>()
  private readonly providerAuthListeners = new Set<(event: ProviderAuthEventV1) => void>()
  private readonly packageProgressListeners = new Set<(event: PackageProgressV1) => void>()
  private child: ChildProcess
  private session!: WorkerSessionWire
  private runtimeState!: PiRuntimeUiState
  private projection: ProjectionState = restoreProjection([])
  private replacementHandler?: (replacement: SessionReplacementResultV1) => void | Promise<void>
  private disposed = false
  private disposing = false
  private disposePromise?: Promise<void>
  private readonly ready: Promise<WorkerHello>
  private readonly closed: Promise<void>
  private resolveReady!: (hello: WorkerHello) => void
  private rejectReady!: (error: Error) => void
  private resolveClosed!: () => void
  private readySettled = false
  private exitHandled = false
  private workerHello?: WorkerHello
  private readonly readyTimer: NodeJS.Timeout
  private heartbeatTimer?: NodeJS.Timeout
  private exitError?: Error
  private closeNotified = false

  private constructor(
    child: ChildProcess,
    private readonly options: PiWorkerClientOptions = {},
  ) {
    this.child = child
    this.ready = new Promise<WorkerHello>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.closed = new Promise<void>(resolve => {
      this.resolveClosed = resolve
    })
    this.readyTimer = setTimeout(() => {
      this.rejectHandshake(new Error("Pi worker handshake timeout"))
      this.terminate()
    }, options.handshakeTimeoutMs ?? 15_000)
    this.readyTimer.unref()
    child.on("message", message => this.handleMessage(message as WorkerMessage))
    child.on("error", error => this.handleExit(error))
    child.on("exit", (code, signal) => {
      this.handleExit(new Error(`Pi worker exited unexpectedly (${signal ?? code ?? "unknown"})`))
      this.notifyClose()
    })
    child.on("close", (code, signal) => {
      this.handleExit(new Error(`Pi worker closed unexpectedly (${signal ?? code ?? "unknown"})`))
      this.notifyClose()
    })
  }

  static async open(
    cwd: string,
    sessionFile?: string,
    workerEntry = getPiWorkerEntryUrl(),
    options?: PiWorkerClientOptions,
  ): Promise<PiWorkerSession> {
    return PiWorkerSession.createHost(workerEntry, options).open(cwd, sessionFile)
  }

  static async listAll(workerEntry = getPiWorkerEntryUrl()): Promise<PiSessionInfo[]> {
    const catalog = PiWorkerSession.createCatalog(workerEntry)
    try {
      return await catalog.listAll()
    } finally {
      await catalog.dispose()
    }
  }

  static async listModels(workerEntry = getPiWorkerEntryUrl()): Promise<PiModelInfo[]> {
    const catalog = PiWorkerSession.createCatalog(workerEntry)
    try {
      return await catalog.listModels()
    } finally {
      await catalog.dispose()
    }
  }

  static createCatalog(workerEntry = getPiWorkerEntryUrl(), options?: PiWorkerClientOptions): PiWorkerCatalog {
    const client = new PiWorkerSession(spawnWorker(workerEntry), options)
    return {
      getHandshake: () => client.getWorkerHandshake(),
      list: cwd => client.listCatalogSessions({ type: "list", cwd }),
      listAll: () => client.listCatalogSessions({ type: "listAll" }),
      listModels: () => client.listCatalogModels(),
      getSettings: cwd => client.getCatalogSettings(cwd),
      patchSettings: (cwd, patch) => client.patchCatalogSettings(cwd, patch),
      getProjectTrust: cwd => client.getCatalogTrust(cwd),
      setProjectTrust: (cwd, decision) => client.setCatalogTrust(cwd, decision),
      listProviders: () => client.listCatalogProviders(),
      startProviderAuth: (providerId, authType) => client.startCatalogProviderAuth(providerId, authType),
      respondProviderAuth: (flowId, promptId, value) => client.respondCatalogProviderAuth(flowId, promptId, value),
      cancelProviderAuth: flowId => client.cancelCatalogProviderAuth(flowId),
      logoutProvider: providerId => client.logoutCatalogProvider(providerId),
      inspectModelRuntime: () => client.inspectCatalogModelRuntime(),
      setRuntimeApiKey: (providerId, apiKey) => client.setCatalogRuntimeApiKey(providerId, apiKey),
      removeRuntimeApiKey: providerId => client.removeCatalogRuntimeApiKey(providerId),
      reloadModelRuntime: () => client.reloadCatalogModelRuntime(),
      refreshModelRuntime: options => client.refreshCatalogModelRuntime(options),
      onProviderAuth: listener => client.onProviderAuth(listener),
      listPackages: cwd => client.listCatalogPackages(cwd),
      managePackage: (cwd, commandId, action, source, local, persist) =>
        client.manageCatalogPackage(cwd, commandId, action, source, local, persist),
      resolvePackages: (cwd, missingAction) => client.resolveCatalogPackages(cwd, missingAction),
      resolveExtensionSources: (cwd, sources, options) => client.resolveCatalogExtensionSources(cwd, sources, options),
      changePackageSource: (cwd, source, operation, local) =>
        client.changeCatalogPackageSource(cwd, source, operation, local),
      getInstalledPackagePath: (cwd, source, scope) => client.getCatalogInstalledPackagePath(cwd, source, scope),
      checkPackageUpdates: cwd => client.checkCatalogPackageUpdates(cwd),
      onPackageProgress: listener => client.onPackageProgress(listener),
      onCrash: listener => client.onCrash(listener),
      dispose: () => client.dispose(),
    }
  }

  static createHost(workerEntry = getPiWorkerEntryUrl(), options?: PiWorkerClientOptions): PiWorkerHost {
    const client = new PiWorkerSession(spawnWorker(workerEntry), options)
    let opened = false
    return {
      getHandshake: () => client.getWorkerHandshake(),
      open: async (cwd, sessionFile) => {
        if (opened) throw new Error("Pi worker host is already in use")
        opened = true
        try {
          const result = await client.request({ type: "open", cwd, sessionFile })
          client.applySession(expectSession(result))
          return client
        } catch (error) {
          await client.dispose()
          throw error
        }
      },
      dispose: () => client.dispose(),
    }
  }

  getWorkerHandshake(): Promise<WorkerHello> {
    return this.ready
  }

  getWorkerGeneration(): string | undefined {
    return this.workerHello?.generation
  }

  onCrash(listener: (error: Error) => void): () => void {
    this.crashListeners.add(listener)
    if (this.exitError && !this.disposed && !this.disposing) {
      const error = this.exitError
      queueMicrotask(() => {
        if (this.crashListeners.has(listener)) listener(error)
      })
    }
    return () => this.crashListeners.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    if (this.closeNotified) queueMicrotask(listener)
    return () => this.closeListeners.delete(listener)
  }

  private async listCatalogSessions(
    command: Extract<WorkerCommand, { type: "list" | "listAll" }>,
  ): Promise<PiSessionInfo[]> {
    const result = await this.request(command)
    if (result.type !== "sessions") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.sessions
  }

  private async listCatalogModels(): Promise<PiModelInfo[]> {
    const result = await this.request({ type: "listModels" })
    if (result.type !== "models") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.models
  }

  private async getCatalogSettings(cwd: string): Promise<PiSettingsSnapshotV1> {
    const result = await this.request({ type: "getSettings", cwd })
    if (result.type !== "settings") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.settings
  }

  private async patchCatalogSettings(cwd: string, patch: PiSettingsPatchV1): Promise<PiSettingsSnapshotV1> {
    const result = await this.request({ type: "patchSettings", cwd, patch })
    if (result.type !== "settings") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.settings
  }

  private async getCatalogTrust(cwd: string): Promise<ProjectTrustV1> {
    const result = await this.request({ type: "getProjectTrust", cwd })
    if (result.type !== "trust") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.trust
  }

  private async setCatalogTrust(cwd: string, decision: boolean | null): Promise<ProjectTrustV1> {
    const result = await this.request({ type: "setProjectTrust", cwd, decision })
    if (result.type !== "trust") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.trust
  }

  private async listCatalogProviders(): Promise<ProviderAuthInfoV1[]> {
    const result = await this.request({ type: "listProviders" })
    if (result.type !== "providers") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.providers
  }

  private async startCatalogProviderAuth(providerId: string, authType: "api_key" | "oauth"): Promise<string> {
    const result = await this.request({ type: "startProviderAuth", providerId, authType })
    if (result.type !== "authFlow") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.flowId
  }

  private async respondCatalogProviderAuth(flowId: string, promptId: string, value: string): Promise<void> {
    await this.request({ type: "respondProviderAuth", flowId, promptId, value })
  }

  private async cancelCatalogProviderAuth(flowId: string): Promise<void> {
    await this.request({ type: "cancelProviderAuth", flowId })
  }

  private async logoutCatalogProvider(providerId: string): Promise<void> {
    await this.request({ type: "logoutProvider", providerId })
  }

  private async inspectCatalogModelRuntime(): Promise<PiModelRuntimeSnapshotV1> {
    const result = await this.request({ type: "inspectModelRuntime" })
    if (result.type !== "modelRuntime") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.runtime
  }

  private async setCatalogRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.request({ type: "setRuntimeApiKey", providerId, apiKey })
  }

  private async removeCatalogRuntimeApiKey(providerId: string): Promise<void> {
    await this.request({ type: "removeRuntimeApiKey", providerId })
  }

  private async reloadCatalogModelRuntime(): Promise<void> {
    await this.request({ type: "reloadModelRuntime" })
  }

  private async refreshCatalogModelRuntime(options?: Record<string, unknown>): Promise<unknown> {
    const result = await this.request({ type: "refreshModelRuntime", options })
    if (result.type !== "modelRefresh") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.result
  }

  onProviderAuth(listener: (event: ProviderAuthEventV1) => void): () => void {
    this.providerAuthListeners.add(listener)
    return () => this.providerAuthListeners.delete(listener)
  }

  listRuntimeProviders(): Promise<ProviderAuthInfoV1[]> {
    return this.listCatalogProviders()
  }

  startRuntimeProviderAuth(providerId: string, authType: "api_key" | "oauth"): Promise<string> {
    return this.startCatalogProviderAuth(providerId, authType)
  }

  respondRuntimeProviderAuth(flowId: string, promptId: string, value: string): Promise<void> {
    return this.respondCatalogProviderAuth(flowId, promptId, value)
  }

  cancelRuntimeProviderAuth(flowId: string): Promise<void> {
    return this.cancelCatalogProviderAuth(flowId)
  }

  logoutRuntimeProvider(providerId: string): Promise<void> {
    return this.logoutCatalogProvider(providerId)
  }

  inspectSessionModelRuntime(): Promise<PiModelRuntimeSnapshotV1> {
    return this.inspectCatalogModelRuntime()
  }

  setSessionRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
    return this.setCatalogRuntimeApiKey(providerId, apiKey)
  }

  removeSessionRuntimeApiKey(providerId: string): Promise<void> {
    return this.removeCatalogRuntimeApiKey(providerId)
  }

  reloadSessionModelRuntime(): Promise<void> {
    return this.reloadCatalogModelRuntime()
  }

  refreshSessionModelRuntime(options?: Record<string, unknown>): Promise<unknown> {
    return this.refreshCatalogModelRuntime(options)
  }

  private async listCatalogPackages(cwd: string): Promise<ConfiguredPackageV1[]> {
    const result = await this.request({ type: "listPackages", cwd })
    if (result.type !== "packages") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.packages
  }

  private async manageCatalogPackage(
    cwd: string,
    commandId: string,
    action: "install" | "remove" | "update",
    source?: string,
    local?: boolean,
    persist?: boolean,
  ): Promise<ConfiguredPackageV1[]> {
    const result = await this.request({ type: "managePackage", cwd, commandId, action, source, local, persist })
    if (result.type !== "packages") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.packages
  }

  private async resolveCatalogPackages(
    cwd: string,
    missingAction?: "skip" | "error",
  ): Promise<ResolvedPackageResourcesV1> {
    const result = await this.request({ type: "resolvePackages", cwd, missingAction })
    if (result.type !== "packageResources") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.resources
  }

  private async resolveCatalogExtensionSources(
    cwd: string,
    sources: string[],
    options: { local?: boolean; temporary?: boolean } = {},
  ): Promise<ResolvedPackageResourcesV1> {
    const result = await this.request({ type: "resolveExtensionSources", cwd, sources, ...options })
    if (result.type !== "packageResources") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.resources
  }

  private async changeCatalogPackageSource(
    cwd: string,
    source: string,
    operation: "add" | "remove",
    local?: boolean,
  ): Promise<{ changed: boolean; packages: ConfiguredPackageV1[] }> {
    const result = await this.request({ type: "changePackageSource", cwd, source, operation, local })
    if (result.type !== "packageSource") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return { changed: result.changed, packages: result.packages }
  }

  private async getCatalogInstalledPackagePath(
    cwd: string,
    source: string,
    scope: "user" | "project",
  ): Promise<string | undefined> {
    const result = await this.request({ type: "getInstalledPackagePath", cwd, source, scope })
    if (result.type !== "packagePath") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.path
  }

  private async checkCatalogPackageUpdates(cwd: string): Promise<PackageUpdateV1[]> {
    const result = await this.request({ type: "checkPackageUpdates", cwd })
    if (result.type !== "packageUpdates") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.updates
  }

  private onPackageProgress(listener: (event: PackageProgressV1) => void): () => void {
    this.packageProgressListeners.add(listener)
    return () => this.packageProgressListeners.delete(listener)
  }

  onState(listener: (state: PiRuntimeUiState) => void): () => void {
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

  getProjection(): ProjectionState { return this.projection }
  getSessionId(): string { return this.session.sessionId }
  getSessionFile(): string | undefined { return this.session.sessionFile }
  getSessionName(): string | undefined { return this.session.sessionName }
  getEntries() { return this.session.entries }
  getTree() { return this.session.tree }
  getLeafId(): string | null { return this.session.leafId }
  getModel() { return this.runtimeState.model }
  getThinkingLevel(): string { return this.runtimeState.thinkingLevel }
  getAvailableThinkingLevels(): string[] { return this.runtimeState.availableThinkingLevels }
  isStreaming(): boolean { return this.runtimeState.isStreaming }
  getRuntimeUiState(): PiRuntimeUiState { return this.runtimeState }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "setModel", provider, modelId })))
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "setThinkingLevel", level })))
  }

  async cycleThinkingLevel(): Promise<string> {
    const result = await this.request({ type: "cycleThinkingLevel" })
    if (result.type !== "thinkingLevel") throw new Error(`unexpected Pi worker result: ${result.type}`)
    this.applySession(result.session)
    return result.level
  }

  async sendUserMessage(text: string, images?: PiImageInput[], deliverAs?: "steer" | "followUp"): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "sendUserMessage", text, images, deliverAs })))
  }

  async cycleModel(direction?: "forward" | "backward"): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "cycleModel", direction })))
  }

  async setScopedModels(patterns: string[]): Promise<Array<{ message: string; pattern: string }>> {
    const result = await this.request({ type: "setScopedModels", patterns })
    if (result.type !== "scopedModels") throw new Error(`unexpected Pi worker result: ${result.type}`)
    this.applySession(result.session)
    return result.diagnostics
  }

  async listAvailableModels(): Promise<PiModelInfo[]> {
    const result = await this.request({ type: "listRuntimeModels" })
    if (result.type !== "models") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.models
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
    this.applySession(expectSession(await this.request({ type: "sendCustomMessage", customType, content, ...options })))
  }

  async appendCustomEntry(customType: string, data?: unknown): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "appendCustomEntry", customType, data })))
  }

  async waitForIdle(): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "waitForIdle" })))
  }

  async getToolDefinition(toolName: string): Promise<unknown> {
    const result = await this.request({ type: "inspectToolDefinition", toolName })
    if (result.type !== "data") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.data
  }

  async hasExtensionHandlers(eventType: string): Promise<boolean> {
    const result = await this.request({ type: "hasExtensionHandlers", eventType })
    if (result.type !== "boolean") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.value
  }

  async getSystemPrompt(): Promise<string> {
    const result = await this.request({ type: "inspectSystemPrompt" })
    if (result.type !== "text") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.text
  }

  async inspectRuntime(): Promise<PiRuntimeInspectionV1> {
    const result = await this.request({ type: "inspectRuntime" })
    if (result.type !== "runtimeInspection") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.inspection
  }

  async inspectResources(): Promise<PiResourceSnapshotV1> {
    const result = await this.request({ type: "inspectResources" })
    if (result.type !== "resources") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.resources
  }

  async extendResources(paths: PiResourceExtensionPathsV1): Promise<void> {
    const result = await this.request({ type: "extendResources", paths })
    if (result.type !== "resources") throw new Error(`unexpected Pi worker result: ${result.type}`)
  }

  async compact(customInstructions?: string): Promise<CompactionCommandResultV1> {
    const result = await this.request({ type: "compact", instructions: customInstructions })
    if (result.type !== "compaction") throw new Error(`unexpected Pi worker result: ${result.type}`)
    this.applySession(result.session)
    return result.compaction
  }

  async abortCompaction(): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "abortCompaction" })))
  }

  async abortBranchSummary(): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "abortBranchSummary" })))
  }

  async abortRetry(): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "abortRetry" })))
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "setAutoCompaction", enabled })))
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "setAutoRetry", enabled })))
  }

  async setQueueModes(modes: {
    steeringMode?: QueueDeliveryModeV1
    followUpMode?: QueueDeliveryModeV1
  }): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "setQueueModes", ...modes })))
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    const result = await this.request({ type: "clearQueue" })
    if (result.type !== "queue") throw new Error(`unexpected Pi worker result: ${result.type}`)
    this.applySession(result.session)
    return { steering: result.steering, followUp: result.followUp }
  }

  async setActiveTools(toolNames: string[]): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "setActiveTools", toolNames })))
  }

  async navigateTree(
    entryId: string,
    options: {
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    } = {},
  ): Promise<PiNavigationResultV1> {
    const result = await this.request({ type: "navigateTree", entryId, ...options })
    if (result.type !== "navigation") throw new Error(`unexpected Pi worker result: ${result.type}`)
    this.applySession(result.session)
    return {
      editorText: result.editorText,
      cancelled: result.cancelled,
      aborted: result.aborted,
      summaryEntry: result.summaryEntry,
    }
  }

  async setLabel(entryId: string, label?: string): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "setLabel", entryId, label })))
  }

  async setSessionName(name: string): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "setSessionName", name })))
  }

  async fork(entryId: string, position: "before" | "at"): Promise<SessionReplacementResultV1> {
    return this.applyReplacement(await this.request({ type: "fork", entryId, position }))
  }

  async clone(entryId?: string): Promise<SessionReplacementResultV1> {
    return this.applyReplacement(await this.request({ type: "clone", entryId }))
  }

  async newSession(parentSession?: string): Promise<SessionReplacementResultV1> {
    return this.applyReplacement(await this.request({ type: "newSession", parentSession }))
  }

  async switchSession(sessionPath: string, cwdOverride?: string): Promise<SessionReplacementResultV1> {
    return this.applyReplacement(await this.request({ type: "switchSession", sessionPath, cwdOverride }))
  }

  async importSession(inputPath: string, cwdOverride?: string): Promise<SessionReplacementResultV1> {
    return this.applyReplacement(await this.request({ type: "importSession", inputPath, cwdOverride }))
  }

  async prompt(text: string, images?: PiImageInput[]): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "prompt", text, images })))
  }

  async steer(text: string, images?: PiImageInput[]): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "steer", text, images })))
  }

  async followUp(text: string, images?: PiImageInput[]): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "followUp", text, images })))
  }

  async abort(): Promise<{ steering: string[]; followUp: string[] }> {
    const result = await this.request({ type: "abort" })
    if (result.type !== "queue") throw new Error(`unexpected Pi worker result: ${result.type}`)
    this.applySession(result.session)
    return { steering: result.steering, followUp: result.followUp }
  }

  async executeBash(command: string, excludeFromContext?: boolean): Promise<PiBashResult> {
    const result = await this.request({ type: "executeBash", command, excludeFromContext })
    if (result.type !== "bash") throw new Error(`unexpected Pi worker result: ${result.type}`)
    this.applySession(result.session)
    return result.result
  }

  async initializeExtensions(): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "initializeExtensions" })))
  }

  onExtensionUi(listener: (event: PiExtensionUiEvent) => void): () => void {
    this.extensionUiListeners.add(listener)
    return () => this.extensionUiListeners.delete(listener)
  }

  async respondExtensionUi(requestId: string, response: ExtensionUiDialogResponseV1): Promise<boolean> {
    await this.request({ type: "respondExtensionUi", requestId, response })
    return true
  }

  async setExtensionEditorState(text: string): Promise<void> {
    await this.request({ type: "setExtensionEditorState", text })
  }

  async abortBash(): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "abortBash" })))
  }

  async exportHtml(outputPath: string): Promise<string> {
    const result = await this.request({ type: "exportHtml", outputPath })
    if (result.type !== "export" || result.format !== "html") {
      throw new Error(`unexpected Pi worker result: ${result.type}`)
    }
    return result.path
  }

  async exportJsonl(outputPath: string): Promise<string> {
    const result = await this.request({ type: "exportJsonl", outputPath })
    if (result.type !== "export" || result.format !== "jsonl") {
      throw new Error(`unexpected Pi worker result: ${result.type}`)
    }
    return result.path
  }

  async reload(): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "reload" })))
  }

  async listSkills(): Promise<PiSkillInfo[]> {
    const result = await this.request({ type: "listSkills" })
    if (result.type !== "skills") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.skills
  }

  async listCommands(): Promise<PiCommandInfo[]> {
    const result = await this.request({ type: "listCommands" })
    if (result.type !== "commands") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.commands
  }

  setReplacementHandler(handler: (replacement: SessionReplacementResultV1) => void | Promise<void>): void {
    this.replacementHandler = handler
  }

  private async applyReplacement(result: WorkerResult): Promise<SessionReplacementResultV1> {
    if (result.type !== "replacement") throw new Error(`unexpected Pi worker result: ${result.type}`)
    try {
      await this.replacementHandler?.(result.replacement)
    } catch (error) {
      const failure = Object.assign(new Error("Pi session replacement lease transfer failed", { cause: error }), {
        code: "SESSION_REPLACEMENT_COMMIT_FAILED",
      })
      await this.dispose()
      throw failure
    }
    this.applySession(result.session)
    return result.replacement
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.disposePromise ??= this.performDispose()
    return this.disposePromise
  }

  private async performDispose(): Promise<void> {
    this.disposing = true
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.request({ type: "dispose" }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Pi worker dispose timeout")), 3000)
          timer.unref()
        }),
      ])
    } catch {
      /* terminate below */
    } finally {
      if (timer) clearTimeout(timer)
      this.disposed = true
      if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
      this.terminate()
      await this.closed
      this.disposing = false
    }
  }

  private async request(command: WorkerCommand): Promise<WorkerResult> {
    const hello = await this.ready
    if (this.disposed || (this.disposing && command.type !== "dispose") || !this.child.connected) {
      return Promise.reject(new Error("Pi worker is not connected"))
    }
    const requiredCapability = workerCapabilityFor(command)
    if (requiredCapability && !hello.capabilities.includes(requiredCapability)) {
      throw Object.assign(new Error(`Pi worker does not support ${requiredCapability}`), {
        code: "CAPABILITY_DISABLED",
      })
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.send({
        kind: "request",
        id,
        generation: hello.generation,
        sessionId: this.session?.sessionId,
        command,
      }, error => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private handleMessage(message: WorkerMessage): void {
    if (message.kind === "hello") {
      if (this.workerHello) return
      if (message.workerProtocolVersion !== PI_WORKER_PROTOCOL_VERSION) {
        this.rejectHandshake(
          Object.assign(
            new Error(
              `Pi worker protocol mismatch: expected ${PI_WORKER_PROTOCOL_VERSION}, received ${message.workerProtocolVersion}`,
            ),
            { code: "WORKER_PROTOCOL_MISMATCH" },
          ),
        )
        this.terminate()
        return
      }
      if (message.piSdkVersion !== PI_PARITY_SDK_VERSION) {
        this.rejectHandshake(
          Object.assign(
            new Error(`Pi SDK mismatch: expected ${PI_PARITY_SDK_VERSION}, received ${message.piSdkVersion}`),
            { code: "PI_SDK_VERSION_MISMATCH" },
          ),
        )
        this.terminate()
        return
      }
      if (!Number.isFinite(message.heartbeatIntervalMs) || message.heartbeatIntervalMs <= 0) {
        this.rejectHandshake(Object.assign(new Error("Pi worker heartbeat interval is invalid"), {
          code: "WORKER_PROTOCOL_MISMATCH",
        }))
        this.terminate()
        return
      }
      this.readySettled = true
      clearTimeout(this.readyTimer)
      this.workerHello = message
      this.armHeartbeat(message.heartbeatIntervalMs)
      this.resolveReady(message)
      return
    }
    if (!this.workerHello || message.generation !== this.workerHello.generation) return
    this.armHeartbeat(this.workerHello.heartbeatIntervalMs)
    if (message.kind === "heartbeat") return
    if (message.kind === "response") {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
      return
    }
    if (message.type === "projection") {
      this.projection = restoreProjection(message.projection.timeline, message.projection.isStreaming)
      for (const listener of this.projectionListeners) listener(this.projection)
      return
    }
    if (message.type === "extensionUi") {
      const event = message.event.type === "requested"
        ? {
            ...message.event,
            request: { ...message.event.request, workerGeneration: message.generation },
          } satisfies PiExtensionUiEvent
        : message.event
      for (const listener of this.extensionUiListeners) listener(event)
      return
    }
    if (message.type === "nativeEvent") {
      for (const listener of this.nativeEventListeners) listener(message.event)
      return
    }
    if (message.type === "resourcesChanged") {
      for (const listener of this.resourceListeners) listener()
      return
    }
    if (message.type === "providerAuth") {
      for (const listener of this.providerAuthListeners) listener(message.event)
      return
    }
    if (message.type === "packageProgress") {
      for (const listener of this.packageProgressListeners) listener(message.event)
      return
    }
    if (message.type === "projectionDelta") {
      const delta = restoreProjection(message.projection.timeline, message.projection.isStreaming)
      const removed = new Set(message.projection.removedItemIds ?? [])
      const timeline = this.projection.timeline.filter(item => !removed.has(item.id))
      const byId = new Map(timeline.map((item, index) => [item.id, index]))
      for (const item of delta.timeline) {
        const index = byId.get(item.id)
        if (index === undefined) {
          byId.set(item.id, timeline.length)
          timeline.push(item)
        } else {
          timeline[index] = item
        }
      }
      this.projection = restoreProjection(timeline, delta.isStreaming)
      for (const listener of this.projectionListeners) listener(this.projection)
      for (const listener of this.projectionDeltaListeners) listener({
        timeline: delta.timeline,
        isStreaming: delta.isStreaming,
        removedItemIds: message.projection.removedItemIds,
      })
      return
    }
    if (!isRuntimeControlStateV1(message.state)) {
      const error = Object.assign(new Error("Pi worker sent an invalid runtime control state"), {
        code: "WORKER_PROTOCOL_MISMATCH",
      })
      this.handleExit(error)
      this.terminate()
      return
    }
    this.runtimeState = message.state
    for (const listener of this.stateListeners) listener(message.state)
  }

  private applySession(session: WorkerSessionWire): void {
    if (!isRuntimeControlStateV1(session.state)) {
      throw Object.assign(new Error("Pi worker sent an invalid runtime control state"), {
        code: "WORKER_PROTOCOL_MISMATCH",
      })
    }
    this.session = session
    this.runtimeState = session.state
    this.projection = restoreProjection(session.projection.timeline, session.projection.isStreaming)
  }

  private handleExit(error: Error): void {
    if (this.exitHandled) return
    this.exitHandled = true
    this.exitError = error
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.rejectHandshake(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (!this.disposed && !this.disposing) {
      for (const listener of this.crashListeners) listener(error)
    }
  }

  private notifyClose(): void {
    if (this.closeNotified) return
    this.closeNotified = true
    for (const listener of this.closeListeners) listener()
    this.resolveClosed()
  }

  private armHeartbeat(workerIntervalMs: number): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    const timeoutMs = this.options.heartbeatTimeoutMs ?? workerIntervalMs * 3
    this.heartbeatTimer = setTimeout(() => {
      const error = Object.assign(new Error("Pi worker heartbeat timeout"), { code: "WORKER_HEARTBEAT_TIMEOUT" })
      this.handleExit(error)
      this.terminate()
    }, timeoutMs)
    this.heartbeatTimer.unref()
  }

  private rejectHandshake(error: Error): void {
    if (this.readySettled) return
    this.readySettled = true
    clearTimeout(this.readyTimer)
    this.rejectReady(error)
  }

  private terminate(): void {
    if (this.child.connected) this.child.disconnect()
    if (!this.child.killed) this.child.kill()
  }
}

function workerCapabilityFor(command: WorkerCommand): PiWorkerCapability | undefined {
  switch (command.type) {
    case "list":
    case "listAll":
      return "catalog.sessions"
    case "listModels":
      return "catalog.models"
    case "open":
      return "runtime.open"
    case "prompt":
      return "runtime.prompt"
    case "steer":
    case "followUp":
    case "setQueueModes":
    case "clearQueue":
      return "runtime.control"
    case "abort":
      return "runtime.abort"
    case "setModel":
    case "cycleModel":
    case "setScopedModels":
    case "listRuntimeModels":
      return "runtime.model"
    case "inspectRuntime":
      return "runtime.tree"
    case "inspectResources":
    case "extendResources":
      return "runtime.reload"
    case "setThinkingLevel":
    case "cycleThinkingLevel":
      return "runtime.thinking"
    case "sendUserMessage":
      return "runtime.prompt"
    case "compact":
    case "abortCompaction":
    case "setAutoCompaction":
      return "runtime.compact"
    case "abortBranchSummary":
      return "runtime.tree"
    case "abortRetry":
    case "setAutoRetry":
      return "runtime.retry"
    case "setActiveTools":
      return "runtime.tools"
    case "executeBash":
    case "abortBash":
      return "runtime.bash"
    case "exportHtml":
    case "exportJsonl":
      return "runtime.export"
    case "reload":
      return "runtime.reload"
    case "getSettings":
    case "patchSettings":
      return "management.settings"
    case "getProjectTrust":
    case "setProjectTrust":
      return "management.trust"
    case "listProviders":
    case "startProviderAuth":
    case "respondProviderAuth":
    case "cancelProviderAuth":
    case "logoutProvider":
    case "inspectModelRuntime":
    case "setRuntimeApiKey":
    case "removeRuntimeApiKey":
    case "reloadModelRuntime":
    case "refreshModelRuntime":
      return "management.auth"
    case "listPackages":
    case "managePackage":
    case "resolvePackages":
    case "resolveExtensionSources":
    case "changePackageSource":
    case "getInstalledPackagePath":
    case "checkPackageUpdates":
      return "management.packages"
    case "initializeExtensions":
    case "respondExtensionUi":
    case "setExtensionEditorState":
      return "runtime.extensionUi"
    case "navigateTree":
    case "setLabel":
    case "setSessionName":
      return "runtime.tree"
    case "fork":
    case "clone":
    case "newSession":
    case "switchSession":
      return "runtime.fork"
    case "importSession":
      return "runtime.import"
    case "listSkills":
      return "runtime.skills"
    case "listCommands":
    case "appendCustomEntry":
    case "waitForIdle":
    case "hasExtensionHandlers":
      return "runtime.commands"
    case "sendCustomMessage":
    case "inspectSystemPrompt":
      return "runtime.commands"
    case "inspectToolDefinition":
      return "runtime.tools"
    case "dispose":
      return undefined
  }
}

function spawnWorker(workerEntry: URL): ChildProcess {
  return fork(fileURLToPath(workerEntry), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: process.env,
  })
}

function expectSession(result: WorkerResult): WorkerSessionWire {
  if (result.type !== "session") throw new Error(`unexpected Pi worker result: ${result.type}`)
  return result.session
}
