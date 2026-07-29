import { randomUUID } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { mkdir, unlink } from "node:fs/promises"
import path from "node:path"
import type {
  CompactionCommandResultV1,
  BashCommandResultV2,
  ExtensionUiDialogRequestV1,
  ExtensionUiDialogResponseV1,
  ExtensionUiSnapshotV1,
  ExtensionUiStatePatchV1,
  ExtensionUiStateV1,
  ExtensionUiSettlementReasonV1,
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
  PiNativeJsonValueV1,
  PiNativeSessionHeadV1,
  QueueDeliveryModeV1,
  SessionAttachmentV2,
  SessionReplacementResultV1,
  SessionExportResultV2,
  SessionSnapshotV1,
} from "@piui/protocol"
import {
  getDriverMode,
  nativeEntriesPageFromEntries,
  type DriverMode,
  type PiModelInfo,
  type PiSessionInfo,
  type PiSessionRuntime,
} from "@piui/pi-worker"
import { workspacePathKey, type WorkspaceStore } from "./workspace-store.ts"
import type { EventHub } from "./event-hub.ts"
import { preparePromptInput } from "./prompt-attachments.ts"
import { resolveWorkspacePath } from "./path-safety.ts"

type NativeEntry = { [key: string]: PiNativeJsonValueV1 }
type MockTreeNode = { entry: NativeEntry; children: MockTreeNode[] }

export interface AppSession {
  id: string
  /** Canonical workspace root. Pi identifies a session by its cwd, so this is
   *  the session's workspace rather than a separate identifier. */
  cwd: string
  driverSessionId: string
  title: string
  createdAt: string
  updatedAt: string
  epoch: string
  sequence: number
  nativeEntries: NativeEntry[]
  driver: DriverMode
  sessionFile?: string
  /** Pi session header parentSession (fork/clone source file). Display-only. */
  parentSessionPath?: string
  real?: PiSessionRuntime
  workerGeneration?: string
  runtimeError?: string
  nativeHead?: PiNativeSessionHeadV1
}

export interface PiSessionBackend {
  list?(cwd: string): Promise<PiSessionInfo[]>
  listAll(): Promise<PiSessionInfo[]>
  listModels?(): Promise<PiModelInfo[]>
  getSettings?(cwd: string): Promise<PiSettingsSnapshotV1>
  patchSettings?(cwd: string, patch: PiSettingsPatchV1): Promise<PiSettingsSnapshotV1>
  getProjectTrust?(cwd: string): Promise<ProjectTrustV1>
  setProjectTrust?(cwd: string, decision: boolean | null): Promise<ProjectTrustV1>
  listProviders?(): Promise<ProviderAuthInfoV1[]>
  startProviderAuth?(providerId: string, authType: "api_key" | "oauth"): Promise<string>
  respondProviderAuth?(flowId: string, promptId: string, value: string): Promise<void>
  cancelProviderAuth?(flowId: string): Promise<void>
  logoutProvider?(providerId: string): Promise<void>
  inspectModelRuntime?(): Promise<PiModelRuntimeSnapshotV1>
  setRuntimeApiKey?(providerId: string, apiKey: string): Promise<void>
  removeRuntimeApiKey?(providerId: string): Promise<void>
  reloadModelRuntime?(): Promise<void>
  refreshModelRuntime?(options?: Record<string, unknown>): Promise<unknown>
  onProviderAuth?(listener: (event: ProviderAuthEventV1) => void): () => void
  listPackages?(cwd: string): Promise<ConfiguredPackageV1[]>
  managePackage?(
    cwd: string,
    commandId: string,
    action: "install" | "remove" | "update",
    source?: string,
    local?: boolean,
    persist?: boolean,
  ): Promise<ConfiguredPackageV1[]>
  resolvePackages?(cwd: string, missingAction?: "install" | "skip" | "error"): Promise<ResolvedPackageResourcesV1>
  resolveExtensionSources?(
    cwd: string,
    sources: string[],
    options?: { local?: boolean; temporary?: boolean },
  ): Promise<ResolvedPackageResourcesV1>
  changePackageSource?(
    cwd: string,
    source: string,
    operation: "add" | "remove",
    local?: boolean,
  ): Promise<{ changed: boolean; packages: ConfiguredPackageV1[] }>
  getInstalledPackagePath?(cwd: string, source: string, scope: "user" | "project"): Promise<string | undefined>
  checkPackageUpdates?(cwd: string): Promise<PackageUpdateV1[]>
  onPackageProgress?(listener: (event: PackageProgressV1) => void): () => void
  open(cwd: string, sessionFile?: string): Promise<PiSessionRuntime>
  dispose?(): Promise<void>
}

const DISCOVERY_TTL_MS = 5_000
/** Each attached runtime is its own process holding ~130MB, so idle ones are
 *  released. Reclaiming this eagerly is fine because reattaching costs ~0.12s
 *  while a warm worker is available, and switching between sessions is far
 *  slower than the pool refills. */
const DEFAULT_IDLE_RUNTIME_TIMEOUT_MS = 2 * 60_000
/** Sweeping well below the timeout keeps the actual reclaim close to it. */
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 30_000

export interface SessionRegistryOptions {
  /** Set to 0 to keep every attached runtime alive. */
  idleRuntimeTimeoutMs?: number
  idleSweepIntervalMs?: number
}

function emptyExtensionUiState(): ExtensionUiStateV1 {
  return {
    revision: 0,
    statuses: {},
    workingVisible: true,
    widgets: {},
    editorText: "",
    toolsExpanded: false,
  }
}

export class SessionRegistry {
  private readonly byId = new Map<string, AppSession>()
  private readonly attaching = new Map<string, Promise<PiSessionRuntime>>()
  private readonly discovering = new Map<string, Promise<void>>()
  private readonly discoveredAt = new Map<string, number>()
  private readonly hiddenIds = new Set<string>()
  private readonly deleting = new Set<string>()
  private readonly runtimeDisposals = new WeakMap<PiSessionRuntime, Promise<void>>()
  private readonly extensionInitializations = new WeakMap<PiSessionRuntime, Promise<void>>()
  private readonly extensionReplacements = new WeakMap<PiSessionRuntime, {
    sourceId: string
    target: AppSession
    replacement: SessionReplacementResultV1
  }>()
  private readonly extensionUiPending = new Map<string, ExtensionUiDialogRequestV1>()
  private readonly extensionUiSettled = new Map<string, {
    sessionId: string
    response?: ExtensionUiDialogResponseV1
    reason: ExtensionUiSettlementReasonV1
  }>()
  private readonly extensionUiResponsesInFlight = new Map<string, {
    fingerprint: string
    promise: Promise<{ alreadySettled: boolean }>
  }>()
  private readonly extensionUiStates = new Map<string, ExtensionUiStateV1>()
  private readonly runtimeBindings = new Map<string, {
    runtime: PiSessionRuntime
    unsubscribe: () => void
  }>()
  private readonly driver: DriverMode
  private backendPromise?: Promise<PiSessionBackend>
  private providerAuthBackend?: PiSessionBackend
  private providerAuthUnsubscribe?: () => void
  private packageProgressUnsubscribe?: () => void
  /** Keyed by a server-generated progress id, because the client-supplied
   *  commandId is not unique across workspaces. */
  private readonly packageCommandWorkspaces = new Map<string, { cwd: string; commandId: string }>()
  private readonly lastActivity = new Map<string, number>()
  private readonly idleRuntimeTimeoutMs: number
  private idleSweepTimer?: NodeJS.Timeout

  constructor(
    private readonly workspaces: WorkspaceStore,
    driver: DriverMode = getDriverMode(),
    private readonly injectedBackend?: PiSessionBackend,
    private readonly eventHub?: EventHub,
    private readonly onRuntimeCrash?: (sessionId: string, workerGeneration: string | undefined, error: Error) => void,
    options: SessionRegistryOptions = {},
  ) {
    this.driver = driver
    this.idleRuntimeTimeoutMs = options.idleRuntimeTimeoutMs ?? DEFAULT_IDLE_RUNTIME_TIMEOUT_MS
    const sweepInterval = options.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS
    if (this.idleRuntimeTimeoutMs > 0 && sweepInterval > 0) {
      this.idleSweepTimer = setInterval(() => void this.reclaimIdleRuntimes(), sweepInterval)
      this.idleSweepTimer.unref()
    }
  }

  private resourceEventCoalescing = 0
  private readonly coalescedResourceWorkspaces = new Set<string>()

  getDriver(): DriverMode {
    return this.driver
  }

  /**
   * Pi reports a session's cwd with whatever casing it recorded, which need not
   * match the canonical path, so workspace membership is compared by key.
   */
  private sessionsIn(cwd: string, attachedOnly = false): AppSession[] {
    const key = workspacePathKey(cwd)
    return [...this.byId.values()].filter(session =>
      workspacePathKey(session.cwd) === key && (!attachedOnly || session.real))
  }

  async list(cwd?: string): Promise<AppSession[]> {
    if (cwd === undefined) {
      await this.discover()
      return [...this.byId.values()]
    }
    const workspace = this.workspaces.resolve(cwd)
    await this.discover(workspace.canonicalRoot)
    return this.sessionsIn(workspace.canonicalRoot)
  }

  async listModels(): Promise<PiModelInfo[]> {
    if (this.driver !== "pi") return []
    const backend = await this.getBackend()
    return backend.listModels?.() ?? []
  }

  async listSessionModels(sessionId: string): Promise<PiModelInfo[]> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("session model catalog")
    return this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => runtime.listAvailableModels())
  }

  async getSettings(cwd: string): Promise<PiSettingsSnapshotV1> {
    const workspace = this.workspaces.resolve(cwd)
    const backend = await this.getBackend()
    if (!backend.getSettings) throw unsupportedRuntimeOperation("settings")
    return backend.getSettings(workspace.canonicalRoot)
  }

  async patchSettings(cwd: string, patch: PiSettingsPatchV1): Promise<PiSettingsSnapshotV1> {
    const workspace = this.workspaces.resolve(cwd)
    const backend = await this.getBackend()
    if (!backend.patchSettings) throw unsupportedRuntimeOperation("settings")
    const result = await backend.patchSettings(workspace.canonicalRoot, patch)
    await this.withCoalescedResourceEvents(workspace.canonicalRoot, () => Promise.all(
      this.sessionsIn(workspace.canonicalRoot, true).map(session => this.reloadResources(session.id, false))))
    return result
  }

  async getProjectTrust(cwd: string): Promise<ProjectTrustV1> {
    const workspace = this.workspaces.resolve(cwd)
    const backend = await this.getBackend()
    if (!backend.getProjectTrust) throw unsupportedRuntimeOperation("project trust")
    return backend.getProjectTrust(workspace.canonicalRoot)
  }

  async setProjectTrust(cwd: string, decision: boolean | null): Promise<ProjectTrustV1> {
    const workspace = this.workspaces.resolve(cwd)
    const backend = await this.getBackend()
    if (!backend.setProjectTrust) throw unsupportedRuntimeOperation("project trust")
    const result = await backend.setProjectTrust(workspace.canonicalRoot, decision)
    const detached: AppSession[] = []
    for (const session of this.sessionsIn(workspace.canonicalRoot, true)) {
      await this.detachRuntime(session)
      detached.push(session)
    }
    // Trust changes force every runtime to reload extensions, so clients must
    // learn the sessions detached instead of keeping a stale attached state.
    for (const session of detached) {
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.snapshot.updated",
        { sessionId: session.id, reason: "runtime", snapshot: this.snapshot(session) },
      )
    }
    if (detached.length > 0) {
      this.eventHub?.publishV2(
        { kind: "workspace", id: workspace.canonicalRoot },
        "workspace.sessions.updated",
        { workspacePath: workspace.canonicalRoot },
      )
    }
    this.publishResourcesUpdated(workspace.canonicalRoot)
    return result
  }

  async listProviders(): Promise<ProviderAuthInfoV1[]> {
    const backend = await this.getBackend()
    if (!backend.listProviders) throw unsupportedRuntimeOperation("provider authentication")
    return backend.listProviders()
  }

  async listSessionProviders(sessionId: string): Promise<ProviderAuthInfoV1[]> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime?.listRuntimeProviders) throw unsupportedRuntimeOperation("session providers")
    return this.runBoundRuntimeCommand(
      session, runtime, session.workerGeneration, () => runtime.listRuntimeProviders!(),
    )
  }

  async startSessionProviderAuth(
    sessionId: string,
    providerId: string,
    authType: "api_key" | "oauth",
  ): Promise<string> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime?.startRuntimeProviderAuth) throw unsupportedRuntimeOperation("session provider authentication")
    return this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.startRuntimeProviderAuth!(providerId, authType),
    )
  }

  async respondSessionProviderAuth(
    sessionId: string,
    flowId: string,
    promptId: string,
    value: string,
  ): Promise<void> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime?.respondRuntimeProviderAuth) throw unsupportedRuntimeOperation("session provider authentication")
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.respondRuntimeProviderAuth!(flowId, promptId, value),
    )
  }

  async cancelSessionProviderAuth(sessionId: string, flowId: string): Promise<void> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime?.cancelRuntimeProviderAuth) throw unsupportedRuntimeOperation("session provider authentication")
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.cancelRuntimeProviderAuth!(flowId),
    )
  }

  async logoutSessionProvider(sessionId: string, providerId: string): Promise<void> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime?.logoutRuntimeProvider) throw unsupportedRuntimeOperation("session provider authentication")
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.logoutRuntimeProvider!(providerId),
    )
    this.publishProviderAuthUpdated(providerId, false, session.id)
  }

  async inspectSessionModelRuntime(sessionId: string): Promise<PiModelRuntimeSnapshotV1> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime?.inspectSessionModelRuntime) throw unsupportedRuntimeOperation("session model runtime")
    return this.runBoundRuntimeCommand(
      session, runtime, session.workerGeneration, () => runtime.inspectSessionModelRuntime!(),
    )
  }

  async setSessionRuntimeApiKey(sessionId: string, providerId: string, apiKey: string): Promise<void> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime?.setSessionRuntimeApiKey) throw unsupportedRuntimeOperation("session runtime API keys")
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.setSessionRuntimeApiKey!(providerId, apiKey),
    )
    this.publishProviderAuthUpdated(providerId, true, session.id)
  }

  async removeSessionRuntimeApiKey(sessionId: string, providerId: string): Promise<void> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime?.removeSessionRuntimeApiKey) throw unsupportedRuntimeOperation("session runtime API keys")
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.removeSessionRuntimeApiKey!(providerId),
    )
    this.publishProviderAuthUpdated(providerId, false, session.id)
  }

  async reloadSessionModelRuntime(sessionId: string): Promise<void> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime?.reloadSessionModelRuntime) throw unsupportedRuntimeOperation("session model runtime reload")
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.reloadSessionModelRuntime!(),
    )
  }

  async refreshSessionModelRuntime(sessionId: string, options?: Record<string, unknown>): Promise<unknown> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime?.refreshSessionModelRuntime) throw unsupportedRuntimeOperation("session model runtime refresh")
    return this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.refreshSessionModelRuntime!(options),
    )
  }

  async startProviderAuth(providerId: string, authType: "api_key" | "oauth"): Promise<string> {
    const backend = await this.getBackend()
    if (!backend.startProviderAuth) throw unsupportedRuntimeOperation("provider authentication")
    return backend.startProviderAuth(providerId, authType)
  }

  async respondProviderAuth(flowId: string, promptId: string, value: string): Promise<void> {
    const backend = await this.getBackend()
    if (!backend.respondProviderAuth) throw unsupportedRuntimeOperation("provider authentication")
    await backend.respondProviderAuth(flowId, promptId, value)
  }

  async cancelProviderAuth(flowId: string): Promise<void> {
    const backend = await this.getBackend()
    if (!backend.cancelProviderAuth) throw unsupportedRuntimeOperation("provider authentication")
    await backend.cancelProviderAuth(flowId)
  }

  async logoutProvider(providerId: string): Promise<void> {
    const backend = await this.getBackend()
    if (!backend.logoutProvider) throw unsupportedRuntimeOperation("provider authentication")
    await backend.logoutProvider(providerId)
    this.publishProviderAuthUpdated(providerId, false)
  }

  /** Credential changes are invisible to clients unless the matching global
   *  provider or session stream reports the resulting auth state. */
  private publishProviderAuthUpdated(providerId: string, authenticated: boolean, sessionId?: string): void {
    this.eventHub?.publishV2(
      sessionId ? { kind: "session", id: sessionId } : { kind: "provider", id: providerId },
      "provider.auth.updated",
      { providerId, authenticated, sessionId },
    )
  }

  async inspectModelRuntime(): Promise<PiModelRuntimeSnapshotV1> {
    const backend = await this.getBackend()
    if (!backend.inspectModelRuntime) throw unsupportedRuntimeOperation("model runtime inspection")
    return backend.inspectModelRuntime()
  }

  async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
    const backend = await this.getBackend()
    if (!backend.setRuntimeApiKey) throw unsupportedRuntimeOperation("runtime API keys")
    await backend.setRuntimeApiKey(providerId, apiKey)
    this.publishProviderAuthUpdated(providerId, true)
  }

  async removeRuntimeApiKey(providerId: string): Promise<void> {
    const backend = await this.getBackend()
    if (!backend.removeRuntimeApiKey) throw unsupportedRuntimeOperation("runtime API keys")
    await backend.removeRuntimeApiKey(providerId)
    this.publishProviderAuthUpdated(providerId, false)
  }

  async reloadModelRuntime(): Promise<void> {
    const backend = await this.getBackend()
    if (!backend.reloadModelRuntime) throw unsupportedRuntimeOperation("model runtime reload")
    await backend.reloadModelRuntime()
  }

  async refreshModelRuntime(options?: Record<string, unknown>): Promise<unknown> {
    const backend = await this.getBackend()
    if (!backend.refreshModelRuntime) throw unsupportedRuntimeOperation("model runtime refresh")
    return backend.refreshModelRuntime(options)
  }

  async listPackages(cwd: string): Promise<ConfiguredPackageV1[]> {
    const workspace = this.workspaces.resolve(cwd)
    const backend = await this.getBackend()
    if (!backend.listPackages) throw unsupportedRuntimeOperation("packages")
    return backend.listPackages(workspace.canonicalRoot)
  }

  async managePackage(
    cwd: string,
    commandId: string,
    action: "install" | "remove" | "update",
    source?: string,
    local?: boolean,
    persist?: boolean,
  ): Promise<ConfiguredPackageV1[]> {
    const workspace = this.workspaces.resolve(cwd)
    const backend = await this.getBackend()
    if (!backend.managePackage) throw unsupportedRuntimeOperation("packages")
    const progressId = randomUUID()
    this.packageCommandWorkspaces.set(progressId, { cwd: workspace.canonicalRoot, commandId })
    let packages: ConfiguredPackageV1[]
    try {
      packages = await backend.managePackage(workspace.canonicalRoot, progressId, action, source, local, persist)
    } finally {
      this.packageCommandWorkspaces.delete(progressId)
    }
    await this.withCoalescedResourceEvents(
      workspace.canonicalRoot,
      () => Promise.all(
        this.sessionsIn(workspace.canonicalRoot, true).map(session => this.reloadResources(session.id, false))),
      commandId,
    )
    return packages
  }

  async resolvePackages(cwd: string, missingAction?: "install" | "skip" | "error"): Promise<ResolvedPackageResourcesV1> {
    const workspace = this.workspaces.resolve(cwd)
    const backend = await this.getBackend()
    if (!backend.resolvePackages) throw unsupportedRuntimeOperation("package resolution")
    return backend.resolvePackages(workspace.canonicalRoot, missingAction)
  }

  async resolveExtensionSources(
    cwd: string,
    sources: string[],
    options?: { local?: boolean; temporary?: boolean },
  ): Promise<ResolvedPackageResourcesV1> {
    const workspace = this.workspaces.resolve(cwd)
    const backend = await this.getBackend()
    if (!backend.resolveExtensionSources) throw unsupportedRuntimeOperation("extension source resolution")
    return backend.resolveExtensionSources(workspace.canonicalRoot, sources, options)
  }

  async changePackageSource(
    cwd: string,
    source: string,
    operation: "add" | "remove",
    local?: boolean,
  ): Promise<{ changed: boolean; packages: ConfiguredPackageV1[] }> {
    const workspace = this.workspaces.resolve(cwd)
    const backend = await this.getBackend()
    if (!backend.changePackageSource) throw unsupportedRuntimeOperation("package settings")
    const result = await backend.changePackageSource(workspace.canonicalRoot, source, operation, local)
    await this.withCoalescedResourceEvents(workspace.canonicalRoot, () => Promise.all(
      this.sessionsIn(workspace.canonicalRoot, true).map(session => this.reloadResources(session.id, false))))
    return result
  }

  async getInstalledPackagePath(
    cwd: string,
    source: string,
    scope: "user" | "project",
  ): Promise<string | undefined> {
    const workspace = this.workspaces.resolve(cwd)
    const backend = await this.getBackend()
    if (!backend.getInstalledPackagePath) throw unsupportedRuntimeOperation("package path")
    return backend.getInstalledPackagePath(workspace.canonicalRoot, source, scope)
  }

  async checkPackageUpdates(cwd: string): Promise<PackageUpdateV1[]> {
    const workspace = this.workspaces.resolve(cwd)
    const backend = await this.getBackend()
    if (!backend.checkPackageUpdates) throw unsupportedRuntimeOperation("package update checks")
    return backend.checkPackageUpdates(workspace.canonicalRoot)
  }

  get(id: string): AppSession | undefined {
    return this.byId.get(id)
  }

  extensionUiSnapshot(sessionId: string): ExtensionUiSnapshotV1 | undefined {
    if (!this.byId.has(sessionId)) return undefined
    return {
      sessionId,
      workerGeneration: this.byId.get(sessionId)?.workerGeneration,
      state: structuredClone(this.extensionUiStates.get(sessionId) ?? emptyExtensionUiState()),
      pending: [...this.extensionUiPending.values()]
        .filter(request => request.sessionId === sessionId)
        .map(request => structuredClone(request)),
    }
  }

  async respondExtensionUi(
    sessionId: string,
    requestId: string,
    response: ExtensionUiDialogResponseV1,
    workerGeneration?: string,
  ): Promise<{ alreadySettled: boolean }> {
    const fingerprint = JSON.stringify({ sessionId, response, workerGeneration })
    const inFlight = this.extensionUiResponsesInFlight.get(requestId)
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        throw Object.assign(new Error("extension UI response conflicts with an in-flight response"), {
          code: "RESPONSE_CONFLICT",
        })
      }
      await inFlight.promise
      return { alreadySettled: true }
    }
    const promise = this.performRespondExtensionUi(sessionId, requestId, response, workerGeneration)
    this.extensionUiResponsesInFlight.set(requestId, { fingerprint, promise })
    try {
      return await promise
    } finally {
      if (this.extensionUiResponsesInFlight.get(requestId)?.promise === promise) {
        this.extensionUiResponsesInFlight.delete(requestId)
      }
    }
  }

  private async performRespondExtensionUi(
    sessionId: string,
    requestId: string,
    response: ExtensionUiDialogResponseV1,
    workerGeneration?: string,
  ): Promise<{ alreadySettled: boolean }> {
    const request = this.extensionUiPending.get(requestId)
    if (!request || request.sessionId !== sessionId) {
      const settled = this.extensionUiSettled.get(requestId)
      if (settled?.sessionId === sessionId) {
        if (!settled.response || JSON.stringify(settled.response) === JSON.stringify(response)) {
          return { alreadySettled: true }
        }
        throw Object.assign(new Error("extension UI response conflicts with the settled response"), {
          code: "RESPONSE_CONFLICT",
        })
      }
      throw Object.assign(new Error("extension UI request not found"), { code: "NOT_FOUND" })
    }
    if (workerGeneration && request.workerGeneration !== workerGeneration) {
      throw Object.assign(new Error("extension UI request belongs to another worker generation"), {
        code: "EXTENSION_UI_CANCELLED",
      })
    }
    if (!("cancelled" in response && response.cancelled)) {
      if (request.kind === "confirm" && !("confirmed" in response)) {
        throw Object.assign(new Error("confirmation response required"), { code: "INVALID_REQUEST" })
      }
      if (request.kind !== "confirm" && !("value" in response)) {
        throw Object.assign(new Error("value response required"), { code: "INVALID_REQUEST" })
      }
      if (request.kind === "select" && "value" in response && !request.options?.includes(response.value)) {
        throw Object.assign(new Error("selected value is not an available option"), { code: "INVALID_REQUEST" })
      }
    }
    const session = this.byId.get(sessionId)
    const runtime = session?.real
    if (!session || !runtime || session.workerGeneration !== request.workerGeneration) {
      this.extensionUiPending.delete(requestId)
      throw Object.assign(new Error("extension UI request is closed"), { code: "EXTENSION_UI_CANCELLED" })
    }
    if (!runtime.respondExtensionUi) throw unsupportedRuntimeOperation("extension UI response")
    await runtime.respondExtensionUi(requestId, response)
    this.extensionUiPending.delete(requestId)
    const newlySettled = this.rememberExtensionUiSettlement(
      requestId,
      sessionId,
      "cancelled" in response ? "user_cancelled" : "submitted",
      response,
    )
    if (newlySettled) {
      this.eventHub?.publishV2(
        { kind: "session", id: sessionId },
        "extension.ui.settled",
        {
          requestId,
          sessionId,
          reason: "cancelled" in response ? "user_cancelled" : "submitted",
        },
      )
    }
    return { alreadySettled: false }
  }

  async setExtensionEditorState(sessionId: string, text: string): Promise<void> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime?.setExtensionEditorState) throw unsupportedRuntimeOperation("extension editor state")
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.setExtensionEditorState!(text),
    )
    const state = this.extensionUiStates.get(sessionId) ?? emptyExtensionUiState()
    this.extensionUiStates.set(sessionId, { ...state, revision: state.revision + 1, editorText: text })
  }

  async delete(id: string): Promise<boolean> {
    const s = this.byId.get(id)
    if (!s) return false
    this.hiddenIds.add(id)
    this.deleting.add(id)
    this.byId.delete(id)
    this.unbindRuntime(s)
    const attached = s.real
    s.real = undefined
    s.workerGeneration = undefined
    const pending = this.attaching.get(id)
    try {
      await Promise.all([
        attached ? this.disposeRuntime(attached) : Promise.resolve(),
        pending?.then(runtime => this.disposeRuntime(runtime)) ?? Promise.resolve(),
      ])
      if (s.driver === "pi" && s.sessionFile) {
        try {
          await unlink(s.sessionFile)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
    } catch (error) {
      this.hiddenIds.delete(id)
      this.byId.set(id, s)
      throw error
    } finally {
      this.deleting.delete(id)
    }
    return true
  }

  /**
   * Create session.
   * - mock: optional seed turn, no LLM
   * - pi: opens real AgentSessionRuntime (models when prompted)
   */
  async create(
    cwd: string,
    opts?: { title?: string; seedMock?: boolean },
  ): Promise<AppSession> {
    const ws = this.workspaces.resolve(cwd)
    const now = new Date().toISOString()
    const nativeEntries: NativeEntry[] = []
    let sequence = 0
    let real: PiSessionRuntime | undefined
    let driverSessionId = `mock-${randomUUID().slice(0, 8)}`

    if (this.driver === "pi") {
      const backend = await this.getBackend()
      real = await backend.open(ws.canonicalRoot)
      driverSessionId = real.getSessionId()
    } else if (opts?.seedMock === true) {
      sequence += appendMockTurnEntries(nativeEntries, {
        userText: "hello from mock",
        assistantText: "this is a mock assistant reply",
        thinking: "mock think",
        tool: { name: "read", args: { path: "README.md" }, result: "# mock\n" },
      })
    }

    const seedMock = opts?.seedMock === true && this.driver === "mock"
    const session: AppSession = {
      id: driverSessionId,
      cwd: ws.canonicalRoot,
      driverSessionId,
      title: opts?.title ?? (seedMock ? "Mock session" : "New chat"),
      createdAt: now,
      updatedAt: now,
      epoch: randomUUID(),
      sequence,
      nativeEntries,
      driver: this.driver,
      sessionFile: real?.getSessionFile(),
      real: undefined,
    }
    this.byId.set(session.id, session)
    if (real) this.bindRuntime(session, real)
    return session
  }

  async prompt(
    sessionId: string,
    text: string,
    opts?: {
      stream?: boolean
      onTick?: (session: AppSession) => void
      onMetadataChange?: (session: AppSession) => void
      delayMs?: number
      model?: { provider?: string; id?: string }
      thinkingLevel?: string
      attachments?: SessionAttachmentV2[]
      expandPromptTemplates?: boolean
    },
  ): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const prepared = preparePromptInput(session.cwd, text, opts?.attachments)
    const trimmed = prepared.text.trim()
    if (!trimmed && prepared.images.length === 0) {
      throw Object.assign(new Error("empty prompt"), { code: "INVALID_REQUEST" as const })
    }
    if (!session.real && prepared.images.length > 0) throw unsupportedRuntimeOperation("image attachments")
    if (session.title === "New chat" || session.title === "Mock session" || session.title === "Mock chat") {
      session.title = (trimmed || "Image attachment").slice(0, 48)
      this.touch(session)
      opts?.onMetadataChange?.(session)
    }

    if (session.real) {
      const runtime = session.real
      const generation = session.workerGeneration
      try {
        await this.runBoundRuntimeCommand(session, runtime, generation, async () => {
          if (opts?.model?.provider && opts.model.id) {
            await runtime.setModel(opts.model.provider, opts.model.id)
          }
          if (opts?.thinkingLevel) {
            await runtime.setThinkingLevel(opts.thinkingLevel)
          }
          return runtime.prompt(trimmed, prepared.images, {
            expandPromptTemplates: opts?.expandPromptTemplates,
          })
        })
      } catch (e) {
        if (!this.isCurrentRuntime(session, runtime, generation)) throw runtimeReplacedError()
        const msg = e instanceof Error ? e.message : String(e)
        const code = e && typeof e === "object" && "code" in e ? String(e.code) : "INTERNAL"
        throw Object.assign(new Error(msg), { code })
      }
      const extensionReplacement = this.extensionReplacements.get(runtime)
      if (!this.isCurrentRuntime(session, runtime, generation)) {
        if (extensionReplacement?.sourceId === session.id) {
          this.extensionReplacements.delete(runtime)
          return extensionReplacement.target
        }
        throw runtimeReplacedError()
      }
      session.sessionFile = runtime.getSessionFile() ?? session.sessionFile
      session.title = runtime.getSessionName() ?? session.title
      session.sequence += 1
      session.updatedAt = new Date().toISOString()
      opts?.onTick?.(session)
      return session
    }

    // mock path — no LLM
    const turn = {
      userText: trimmed,
      assistantText: `mock reply: ${trimmed.slice(0, 200)}`,
      thinking: "mock thinking",
    }
    const delay = opts?.stream ? (opts.delayMs ?? 25) : 0
    if (delay > 0) await new Promise(r => setTimeout(r, delay))
    session.sequence += appendMockTurnEntries(session.nativeEntries, turn)
    session.updatedAt = new Date().toISOString()
    opts?.onTick?.(session)
    return session
  }

  async deliverControl(
    sessionId: string,
    text: string,
    delivery: "steer" | "followUp",
    attachments?: SessionAttachmentV2[],
  ): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const prepared = preparePromptInput(session.cwd, text, attachments)
    const trimmed = prepared.text.trim()
    if (!trimmed && prepared.images.length === 0) {
      throw Object.assign(new Error("empty prompt"), { code: "INVALID_REQUEST" as const })
    }
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation(delivery)
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => delivery === "steer"
        ? runtime.steer(trimmed, prepared.images)
        : runtime.followUp(trimmed, prepared.images),
    )
    this.touch(session)
    return session
  }

  async sendUserMessage(
    sessionId: string,
    text: string,
    options?: { deliverAs?: "steer" | "followUp"; attachments?: SessionAttachmentV2[] },
  ): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const prepared = preparePromptInput(session.cwd, text, options?.attachments)
    const trimmed = prepared.text.trim()
    if (!trimmed && prepared.images.length === 0) {
      throw Object.assign(new Error("empty prompt"), { code: "INVALID_REQUEST" as const })
    }
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("user messages")
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.sendUserMessage(trimmed, prepared.images, options?.deliverAs),
    )
    this.touch(session)
    return session
  }

  async abort(sessionId: string): Promise<{
    session: AppSession
    cleared: { steering: string[]; followUp: string[] }
  } | undefined> {
    const session = await this.find(sessionId)
    if (!session) return undefined
    await this.attach(sessionId)
    const runtime = session.real
    const generation = session.workerGeneration
    let cleared = { steering: [] as string[], followUp: [] as string[] }
    if (runtime) {
      cleared = await this.runBoundRuntimeCommand(session, runtime, generation, () => runtime.abort())
    }
    session.sequence += 1
    session.updatedAt = new Date().toISOString()
    return { session, cleared }
  }

  async executeBash(
    sessionId: string,
    command: string,
    excludeFromContext = false,
  ): Promise<BashCommandResultV2> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("user bash")
    const result = await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.executeBash(command, excludeFromContext),
    )
    this.touch(session)
    return {
      output: result.output,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      fullOutputAvailable: Boolean(result.fullOutputPath),
    }
  }

  async abortBash(sessionId: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("abort bash")
    await this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => runtime.abortBash())
    this.touch(session)
    return session
  }

  async exportSession(
    sessionId: string,
    format: "html" | "jsonl",
    outputPath?: string,
  ): Promise<SessionExportResultV2> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("session export")
    const safeId = session.id.replace(/[^A-Za-z0-9._-]/g, "-")
    const relative = outputPath?.trim() || `pi-session-${safeId}.${format}`
    const resolved = resolveWorkspacePath(session.cwd, relative)
    if (resolved.exists && statSync(resolved.absolute).isDirectory()) {
      throw Object.assign(new Error("export path must be a file"), { code: "INVALID_REQUEST" })
    }
    await mkdir(path.dirname(resolved.absolute), { recursive: true })
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => format === "html" ? runtime.exportHtml(resolved.absolute) : runtime.exportJsonl(resolved.absolute),
    )
    return { format, path: resolved.relative }
  }

  async reloadResources(sessionId: string, publish: boolean | string = true): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("resource reload")
    await this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => runtime.reload())
    session.nativeHead = runtime.getNativeHead()
    this.touch(session)
    if (publish !== false) {
      this.publishResourcesUpdated(session.cwd, typeof publish === "string" ? publish : undefined)
    }
    return session
  }

  async setModel(sessionId: string, provider: string, modelId: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    const generation = session.workerGeneration
    if (runtime) {
      await this.runBoundRuntimeCommand(session, runtime, generation, () => runtime.setModel(provider, modelId))
    }
    session.sequence += 1
    session.updatedAt = new Date().toISOString()
    return session
  }

  async cycleModel(sessionId: string, direction?: "forward" | "backward"): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("cycle model")
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.cycleModel(direction),
    )
    this.touch(session)
    return session
  }

  async setScopedModels(
    sessionId: string,
    patterns: string[],
  ): Promise<{ session: AppSession; diagnostics: Array<{ message: string; pattern: string }> }> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("scoped models")
    const diagnostics = await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.setScopedModels(patterns),
    )
    this.touch(session)
    return { session, diagnostics }
  }

  async sendCustomMessage(
    sessionId: string,
    customType: string,
    content: CustomMessageContentV1[],
    options: {
      display: boolean
      details?: unknown
      triggerTurn?: boolean
      deliverAs?: "steer" | "followUp" | "nextTurn"
    },
  ): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("custom messages")
    await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.sendCustomMessage(customType, content, options),
    )
    this.touch(session)
    return session
  }

  async appendCustomEntry(sessionId: string, customType: string, data?: unknown): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("custom entries")
    await this.runBoundRuntimeCommand(
      session, runtime, session.workerGeneration, () => runtime.appendCustomEntry(customType, data),
    )
    session.nativeHead = runtime.getNativeHead()
    this.touch(session)
    return session
  }

  async waitForIdle(sessionId: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("wait for idle")
    await this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => runtime.waitForIdle())
    return session
  }

  async getToolDefinition(sessionId: string, toolName: string): Promise<unknown> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("tool definitions")
    return this.runBoundRuntimeCommand(
      session, runtime, session.workerGeneration, () => runtime.getToolDefinition(toolName),
    )
  }

  async hasExtensionHandlers(sessionId: string, eventType: string): Promise<boolean> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("extension handlers")
    return this.runBoundRuntimeCommand(
      session, runtime, session.workerGeneration, () => runtime.hasExtensionHandlers(eventType),
    )
  }

  async getSystemPrompt(sessionId: string): Promise<string> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("system prompt")
    return this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => runtime.getSystemPrompt())
  }

  async inspectRuntime(sessionId: string): Promise<PiRuntimeInspectionV1> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("runtime inspection")
    return this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => runtime.inspectRuntime())
  }

  async inspectResources(sessionId: string): Promise<PiResourceSnapshotV1> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("resource inspection")
    return this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => runtime.inspectResources())
  }

  async extendResources(sessionId: string, paths: PiResourceExtensionPathsV1): Promise<PiResourceSnapshotV1> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("resource extension")
    await this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => runtime.extendResources(paths))
    this.touch(session)
    this.publishResourcesUpdated(session.cwd)
    return this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => runtime.inspectResources())
  }

  async setThinkingLevel(sessionId: string, level: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    const generation = session.workerGeneration
    if (runtime) {
      await this.runBoundRuntimeCommand(session, runtime, generation, () => runtime.setThinkingLevel(level))
    }
    session.sequence += 1
    session.updatedAt = new Date().toISOString()
    return session
  }

  async cycleThinkingLevel(sessionId: string): Promise<{ session: AppSession; level: string }> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("thinking level cycling")
    const level = await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.cycleThinkingLevel(),
    )
    session.sequence += 1
    session.updatedAt = new Date().toISOString()
    return { session, level }
  }

  async compact(
    sessionId: string,
    instructions?: string,
  ): Promise<{ session: AppSession; result: CompactionCommandResultV1 }> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    const generation = session.workerGeneration
    let result: CompactionCommandResultV1 = {
      status: "skipped",
      reason: "session_too_small",
      message: "Mock sessions do not compact",
    }
    if (runtime) {
      result = await this.runBoundRuntimeCommand(session, runtime, generation, () => runtime.compact(instructions))
    }
    this.touch(session)
    return { session, result }
  }

  async abortCompaction(sessionId: string): Promise<AppSession> {
    return this.runControl(sessionId, runtime => runtime.abortCompaction())
  }

  async abortBranchSummary(sessionId: string): Promise<AppSession> {
    return this.runControl(sessionId, runtime => runtime.abortBranchSummary())
  }

  async abortRetry(sessionId: string): Promise<AppSession> {
    return this.runControl(sessionId, runtime => runtime.abortRetry())
  }

  async setAutoCompaction(sessionId: string, enabled: boolean): Promise<AppSession> {
    return this.runControl(sessionId, runtime => runtime.setAutoCompaction(enabled))
  }

  async setAutoRetry(sessionId: string, enabled: boolean): Promise<AppSession> {
    return this.runControl(sessionId, runtime => runtime.setAutoRetry(enabled))
  }

  async setQueueModes(
    sessionId: string,
    modes: { steeringMode?: QueueDeliveryModeV1; followUpMode?: QueueDeliveryModeV1 },
  ): Promise<AppSession> {
    return this.runControl(sessionId, runtime => runtime.setQueueModes(modes))
  }

  async clearQueue(sessionId: string): Promise<{
    session: AppSession
    cleared: { steering: string[]; followUp: string[] }
  }> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("queue")
    const cleared = await this.runBoundRuntimeCommand(
      session,
      runtime,
      session.workerGeneration,
      () => runtime.clearQueue(),
    )
    this.touch(session)
    return { session, cleared }
  }

  async setActiveTools(sessionId: string, toolNames: string[]): Promise<AppSession> {
    return this.runControl(sessionId, runtime => runtime.setActiveTools(toolNames))
  }

  async navigateTree(
    sessionId: string,
    entryId: string,
    options: {
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    } = {},
  ): Promise<{ session: AppSession } & PiNavigationResultV1> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("tree navigation")
    const generation = session.workerGeneration
    let result!: PiNavigationResultV1
    await this.runBoundRuntimeCommand(session, runtime, generation, async () => {
      result = await runtime.navigateTree(entryId, options)
    })
    this.touch(session)
    return { session, ...result }
  }

  async setLabel(sessionId: string, entryId: string, label?: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("entry labels")
    await this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => runtime.setLabel(entryId, label))
    this.touch(session)
    return session
  }

  async setSessionName(sessionId: string, name: string): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const normalized = name.replace(/[\r\n]+/g, " ").trim()
    if (session.real) {
      await this.runBoundRuntimeCommand(
        session,
        session.real,
        session.workerGeneration,
        () => session.real!.setSessionName(normalized),
      )
    }
    session.title = normalized || "New chat"
    this.touch(session)
    return session
  }

  forkSession(
    sessionId: string,
    entryId: string,
    position: "before" | "at",
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    return this.replaceSession(sessionId, runtime => runtime.fork(entryId, position), { linkParent: true })
  }

  cloneSession(
    sessionId: string,
    entryId?: string,
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    return this.replaceSession(sessionId, runtime => runtime.clone(entryId), { linkParent: true })
  }

  async newSession(
    sessionId: string,
    parentSessionId?: string,
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    let parentSession: string | undefined
    if (parentSessionId) {
      const parent = await this.find(parentSessionId)
      if (!parent?.sessionFile) {
        throw Object.assign(new Error("parent session not found"), { code: "SESSION_NOT_FOUND" })
      }
      parentSession = parent.sessionFile
    }
    return this.replaceSession(sessionId, runtime => runtime.newSession(parentSession))
  }

  async switchSession(
    sessionId: string,
    targetSessionId: string,
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    if (sessionId === targetSessionId) {
      throw Object.assign(new Error("source and target session must differ"), { code: "INVALID_REQUEST" })
    }
    const target = await this.find(targetSessionId)
    if (!target?.sessionFile) throw Object.assign(new Error("target session not found"), { code: "SESSION_NOT_FOUND" })
    if (target.real) throw Object.assign(new Error("target session is active"), { code: "SESSION_BUSY" })
    return this.replaceSession(
      sessionId,
      runtime => runtime.switchSession(target.sessionFile!, target.cwd),
      { existingTargetId: targetSessionId },
    )
  }

  importSession(
    sessionId: string,
    inputPath: string,
    cwdOverride?: string,
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    return this.replaceSession(sessionId, runtime => runtime.importSession(inputPath, cwdOverride))
  }

  async listSkills(sessionId: string) {
    const session = await this.attach(sessionId)
    return session.real?.listSkills() ?? []
  }

  async listCommands(sessionId: string) {
    const session = await this.attach(sessionId)
    if (session.real) return session.real.listCommands()
    return [
      { name: "new", description: "New session", source: "builtin" as const },
      { name: "compact", description: "Compact (mock no-op)", source: "builtin" as const },
    ]
  }

  private require(sessionId: string): AppSession {
    const session = this.byId.get(sessionId)
    if (!session) {
      throw Object.assign(new Error("session not found"), { code: "SESSION_NOT_FOUND" as const })
    }
    return session
  }

  private touch(session: AppSession): void {
    session.sequence += 1
    session.updatedAt = new Date().toISOString()
  }

  private async runControl(
    sessionId: string,
    control: (runtime: PiSessionRuntime) => void | Promise<void>,
  ): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw unsupportedRuntimeOperation("session control")
    await this.runBoundRuntimeCommand(session, runtime, session.workerGeneration, () => control(runtime))
    this.touch(session)
    return session
  }

  private async replaceSession(
    sessionId: string,
    replace: (runtime: PiSessionRuntime) => Promise<SessionReplacementResultV1>,
    options: { existingTargetId?: string; linkParent?: boolean } = {},
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    const source = await this.attach(sessionId)
    const runtime = source.real
    if (!runtime) throw unsupportedRuntimeOperation("session replacement")
    const sourceGeneration = source.workerGeneration
    source.nativeHead = runtime.getNativeHead()
    let replacement: SessionReplacementResultV1
    try {
      replacement = await replace(runtime)
    } catch (error) {
      if ((error as { code?: string }).code === "SESSION_REPLACEMENT_COMMIT_FAILED") {
        this.unbindRuntime(source)
        source.real = undefined
        source.workerGeneration = undefined
        this.touch(source)
        await this.disposeRuntime(runtime)
      }
      throw error
    }
    return this.commitReplacement(source, runtime, sourceGeneration, replacement, options)
  }

  private async commitReplacement(
    source: AppSession,
    runtime: PiSessionRuntime,
    sourceGeneration: string | undefined,
    replacement: SessionReplacementResultV1,
    options: { existingTargetId?: string; linkParent?: boolean } = {},
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    if (replacement.cancelled) return { source, target: source, replacement }
    if (!this.isCurrentRuntime(source, runtime, sourceGeneration)) throw runtimeReplacedError()

    const targetId = replacement.targetSessionId
    try {
      if (!targetId || targetId === source.id) {
        throw Object.assign(new Error("Pi session replacement did not produce a new session"), { code: "INTERNAL" })
      }
      if (options.existingTargetId && targetId !== options.existingTargetId) {
        throw Object.assign(new Error("Pi switched to an unexpected session"), { code: "INTERNAL" })
      }
      const existingTarget = this.byId.get(targetId)
      const mayReuseTarget = existingTarget?.id === options.existingTargetId
      if (existingTarget && !mayReuseTarget) {
        throw Object.assign(new Error("Replacement target already exists"), { code: "SESSION_BUSY" })
      }
      if (existingTarget?.real) {
        throw Object.assign(new Error("Replacement target is active"), { code: "SESSION_BUSY" })
      }
      const targetSessionFile = replacement.targetSessionFile ?? runtime.getSessionFile()
      if (sameSessionFile(source.sessionFile, targetSessionFile)) {
        throw Object.assign(new Error("Replacement target reused the source session file"), {
          code: "SESSION_REPLACEMENT_FILE_CONFLICT",
        })
      }

      this.unbindRuntime(source)
      source.real = undefined
      source.workerGeneration = undefined
      this.touch(source)

      // A replacement may move the session to a different directory.
      const targetCwd = replacement.targetCwd
        ? this.workspaces.resolve(replacement.targetCwd).canonicalRoot
        : source.cwd
      const now = new Date().toISOString()
      const target: AppSession = existingTarget ?? {
        id: targetId,
        cwd: targetCwd,
        driverSessionId: targetId,
        title: runtime.getSessionName() ?? source.title,
        createdAt: now,
        updatedAt: now,
        epoch: randomUUID(),
        sequence: 0,
        nativeEntries: [],
        driver: "pi",
        sessionFile: targetSessionFile,
      }
      if (options.linkParent && source.sessionFile) target.parentSessionPath = source.sessionFile
      target.cwd = targetCwd
      target.sessionFile = targetSessionFile
      target.driverSessionId = targetId
      target.updatedAt = now
      target.runtimeError = undefined
      this.byId.set(target.id, target)
      this.bindRuntime(target, runtime)
      return { source, target, replacement }
    } catch (error) {
      if (targetId && this.byId.get(targetId)?.real === runtime) this.byId.delete(targetId)
      this.unbindRuntime(source)
      source.real = undefined
      source.workerGeneration = undefined
      this.touch(source)
      await this.disposeRuntime(runtime)
      throw error
    }
  }

  async find(sessionId: string): Promise<AppSession | undefined> {
    if (!this.byId.has(sessionId)) await this.discover()
    return this.byId.get(sessionId)
  }

  async attach(sessionId: string): Promise<AppSession> {
    const session = await this.find(sessionId)
    if (!session) {
      throw Object.assign(new Error("session not found"), { code: "SESSION_NOT_FOUND" as const })
    }
    // Every session-scoped route funnels through attach, so this is the single
    // place that keeps a runtime from being reclaimed while it is in use.
    this.lastActivity.set(sessionId, Date.now())
    if (session.driver !== "pi" || session.real) return session
    let pending = this.attaching.get(sessionId)
    if (!pending) {
      pending = this.openRealSession(session)
      this.attaching.set(sessionId, pending)
      void pending.then(() => {
        if (this.attaching.get(sessionId) === pending) this.attaching.delete(sessionId)
      }, () => {
        if (this.attaching.get(sessionId) === pending) this.attaching.delete(sessionId)
      })
    }
    const runtime = await pending
    if (this.deleting.has(sessionId) || this.byId.get(sessionId) !== session) {
      try {
        await this.disposeRuntime(runtime)
      } catch {
        /* preserve SESSION_NOT_FOUND after best-effort cleanup */
      }
      throw Object.assign(new Error("session not found"), { code: "SESSION_NOT_FOUND" as const })
    }
    if (session.sessionFile && runtime.getSessionId() !== session.driverSessionId) {
      try {
        await this.disposeRuntime(runtime)
      } catch {
        /* preserve identity mismatch error after best-effort cleanup */
      }
      throw Object.assign(new Error("Pi session file no longer contains the requested session"), {
        code: "SESSION_IDENTITY_MISMATCH",
      })
    }
    if (!session.real) {
      this.bindRuntime(session, runtime)
    }
    return session
  }

  private async openRealSession(session: AppSession): Promise<PiSessionRuntime> {
    if (this.driver !== "pi") {
      throw Object.assign(new Error("Pi runtime is not enabled"), { code: "DRIVER_UNAVAILABLE" })
    }
    const backend = await this.getBackend()
    return backend.open(session.cwd, session.sessionFile)
  }

  private bindRuntime(session: AppSession, runtime: PiSessionRuntime): void {
    this.unbindRuntime(session)
    session.real = runtime
    session.driverSessionId = runtime.getSessionId()
    session.sessionFile = runtime.getSessionFile() ?? session.sessionFile
    session.title = runtime.getSessionName() ?? session.title
    session.workerGeneration = runtime.getWorkerGeneration?.()
    session.nativeHead = runtime.getNativeHead()
    session.runtimeError = undefined
    session.sequence += 1
    session.updatedAt = new Date().toISOString()

    const generation = session.workerGeneration
    const binding = { runtime, unsubscribe: () => {} }
    this.runtimeBindings.set(session.id, binding)
    if (generation) {
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.runtime.replaced",
        { sessionId: session.id, workerGeneration: generation },
      )
    }
    this.eventHub?.publishV2(
      { kind: "session", id: session.id },
      "session.snapshot.updated",
      { sessionId: session.id, reason: "runtime", snapshot: this.snapshot(session) },
    )
    let initialState = true
    const unsubscribeState = runtime.onState?.(() => {
      if (initialState) {
        initialState = false
        return
      }
      if (!this.isCurrentSessionRuntime(session, runtime, generation)) return
      session.sequence += 1
      session.updatedAt = new Date().toISOString()
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.snapshot.updated",
        { sessionId: session.id, reason: "runtime", snapshot: this.snapshot(session) },
      )
    })
    const unsubscribeNativeEvent = runtime.onNativeEvent?.((event, meta) => {
      if (!this.isCurrentSessionRuntime(session, runtime, generation)) return
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.native.event",
        { sessionId: session.id, event, meta },
      )
    })
    const unsubscribeProviderAuth = runtime.onProviderAuth?.(event => {
      if (!this.isCurrentSessionRuntime(session, runtime, generation)) return
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "provider.auth.flow",
        event,
      )
      if (event.type === "completed") {
        this.publishProviderAuthUpdated(event.providerId, true, session.id)
      }
    })
    const unsubscribeResourcesChanged = runtime.onResourcesChanged?.(() => {
      if (!this.isCurrentSessionRuntime(session, runtime, generation)) return
      this.publishResourcesUpdated(session.cwd)
    })
    const unsubscribeExtensionUi = runtime.onExtensionUi?.(event => {
      if (!this.isCurrentSessionRuntime(session, runtime, generation)) return
      if (event.type === "requested") {
        const request = {
          ...event.request,
          sessionId: session.id,
          workerGeneration: generation,
        }
        this.extensionUiPending.set(request.requestId, request)
        this.eventHub?.publishV2(
          { kind: "session", id: session.id },
          "extension.ui.requested",
          request,
        )
        return
      }
      if (event.type === "settled") {
        this.extensionUiPending.delete(event.requestId)
        if (this.rememberExtensionUiSettlement(event.requestId, session.id, event.reason)) {
          this.eventHub?.publishV2(
            { kind: "session", id: session.id },
            "extension.ui.settled",
            { requestId: event.requestId, sessionId: session.id, reason: event.reason },
          )
        }
        return
      }
      if (event.type === "state") {
        const state = this.applyExtensionUiPatch(session.id, event.patch)
        this.eventHub?.publishV2(
          { kind: "session", id: session.id },
          "extension.ui.state.updated",
          { sessionId: session.id, patch: event.patch, state },
        )
        return
      }
      if (event.type === "notify") {
        this.eventHub?.publishV2(
          { kind: "session", id: session.id },
          "extension.ui.notified",
          { sessionId: session.id, message: event.message, notifyType: event.notifyType },
        )
        return
      }
      const editorState = this.extensionUiStates.get(session.id) ?? emptyExtensionUiState()
      const editorText = event.command.kind === "set"
        ? event.command.text
        : editorState.editorText + event.command.text
      this.extensionUiStates.set(session.id, {
        ...editorState,
        revision: editorState.revision + 1,
        editorText,
      })
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "extension.ui.editor.command",
        { sessionId: session.id, command: event.command },
      )
    })
    const unsubscribeNativeHead = runtime.onNativeHead?.(native => {
      if (!this.isCurrentSessionRuntime(session, runtime, generation)) return
      session.nativeHead = native
      this.touch(session)
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.snapshot.updated",
        { sessionId: session.id, reason: "runtime", snapshot: this.snapshot(session) },
      )
    })
    const unsubscribeSessionReplacement = runtime.onSessionReplacement?.(async replacement => {
      if (!this.isCurrentRuntime(session, runtime, generation)) throw runtimeReplacedError()
      const result = await this.commitReplacement(
        session,
        runtime,
        generation,
        replacement,
        { existingTargetId: replacement.operation === "switch" ? replacement.targetSessionId : undefined },
      )
      this.extensionReplacements.set(runtime, {
        sourceId: session.id,
        target: result.target,
        replacement,
      })
      this.eventHub?.publishV2(
        { kind: "workspace", id: result.target.cwd },
        "workspace.sessions.updated",
        { workspacePath: result.target.cwd, sessionId: result.target.id },
      )
    })
    const unsubscribeCrash = runtime.onCrash?.(error => {
      if (!this.isCurrentRuntime(session, runtime, generation)) return
      this.runtimeBindings.delete(session.id)
      binding.unsubscribe()
      this.closeExtensionUi(session.id, "runtime_crashed", generation)
      session.nativeHead = runtime.getNativeHead()
      session.real = undefined
      session.runtimeError = error.message
      session.sequence += 1
      session.updatedAt = new Date().toISOString()
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.runtime.crashed",
        { sessionId: session.id, workerGeneration: generation, message: error.message },
      )
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.snapshot.updated",
        { sessionId: session.id, reason: "runtime", snapshot: this.snapshot(session) },
      )
      this.onRuntimeCrash?.(session.id, generation, error)
    })
    const unsubscribeClose = runtime.onClose?.(() => {
      if (!this.isCurrentRuntime(session, runtime, generation)) return
      this.runtimeBindings.delete(session.id)
      binding.unsubscribe()
      this.closeExtensionUi(session.id, "runtime_disposed", generation)
      session.nativeHead = runtime.getNativeHead()
      session.real = undefined
      session.workerGeneration = undefined
      this.touch(session)
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.snapshot.updated",
        { sessionId: session.id, reason: "runtime", snapshot: this.snapshot(session) },
      )
    })
    binding.unsubscribe = () => {
      unsubscribeState?.()
      unsubscribeNativeEvent?.()
      unsubscribeNativeHead?.()
      unsubscribeProviderAuth?.()
      unsubscribeResourcesChanged?.()
      unsubscribeExtensionUi?.()
      unsubscribeSessionReplacement?.()
      unsubscribeCrash?.()
      unsubscribeClose?.()
    }
    const initialization = runtime.initializeExtensions?.() ?? Promise.resolve()
    this.extensionInitializations.set(runtime, initialization)
    void initialization.catch(error => {
      if (!this.isCurrentSessionRuntime(session, runtime, generation)) return
      session.runtimeError = error instanceof Error ? error.message : String(error)
      this.touch(session)
    })
  }

  private applyExtensionUiPatch(sessionId: string, patch: ExtensionUiStatePatchV1): ExtensionUiStateV1 {
    const previous = this.extensionUiStates.get(sessionId) ?? emptyExtensionUiState()
    let next: ExtensionUiStateV1 = { ...previous, revision: previous.revision + 1 }
    if (patch.kind === "status") {
      const statuses = { ...previous.statuses }
      if (patch.text === undefined) delete statuses[patch.key]
      else statuses[patch.key] = patch.text
      next = { ...next, statuses }
    } else if (patch.kind === "workingMessage") {
      next = { ...next, workingMessage: patch.message }
    } else if (patch.kind === "workingVisible") {
      next = { ...next, workingVisible: patch.visible }
    } else if (patch.kind === "workingIndicator") {
      next = { ...next, workingIndicator: patch.frames ? { frames: [...patch.frames], intervalMs: patch.intervalMs } : undefined }
    } else if (patch.kind === "hiddenThinkingLabel") {
      next = { ...next, hiddenThinkingLabel: patch.label }
    } else if (patch.kind === "widget") {
      const widgets = { ...previous.widgets }
      if (!patch.lines) delete widgets[patch.key]
      else widgets[patch.key] = { lines: [...patch.lines], placement: patch.placement ?? "aboveEditor" }
      next = { ...next, widgets }
    } else if (patch.kind === "title") {
      next = { ...next, title: patch.title }
    } else if (patch.kind === "theme") {
      next = { ...next, themeName: patch.name }
    } else {
      next = { ...next, toolsExpanded: patch.expanded }
    }
    this.extensionUiStates.set(sessionId, next)
    return structuredClone(next)
  }

  private isCurrentRuntime(
    session: AppSession,
    runtime: PiSessionRuntime,
    generation: string | undefined,
  ): boolean {
    return session.real === runtime && session.workerGeneration === generation &&
      this.runtimeBindings.get(session.id)?.runtime === runtime
  }

  private isCurrentSessionRuntime(
    session: AppSession,
    runtime: PiSessionRuntime,
    generation: string | undefined,
  ): boolean {
    return this.isCurrentRuntime(session, runtime, generation) && runtime.getSessionId() === session.driverSessionId
  }

  private async runBoundRuntimeCommand<T>(
    session: AppSession,
    runtime: PiSessionRuntime,
    generation: string | undefined,
    run: () => T | Promise<T>,
  ): Promise<T> {
    let result: T
    try {
      await this.extensionInitializations.get(runtime)
      if (!this.isCurrentRuntime(session, runtime, generation)) throw runtimeReplacedError()
      result = await run()
    } catch (error) {
      if (!this.isCurrentRuntime(session, runtime, generation)) throw runtimeReplacedError()
      throw error
    }
    if (!this.isCurrentRuntime(session, runtime, generation) &&
      this.extensionReplacements.get(runtime)?.sourceId !== session.id) throw runtimeReplacedError()
    return result
  }

  /**
   * Only reclaim a runtime when nothing is in flight. This is deliberately
   * conservative: reclaiming late just costs memory, but reclaiming a session
   * that is mid-turn would drop queued work and streaming output.
   */
  private isRuntimeReclaimable(session: AppSession): boolean {
    if (!session.real || session.runtimeError) return false
    if (this.attaching.has(session.id) || this.deleting.has(session.id)) return false
    if (session.real.isStreaming()) return false
    const ui = session.real.getRuntimeUiState()
    if (!ui) return false
    if (ui.isStreaming || ui.isCompacting || ui.isBashRunning || ui.hasPendingBashMessages) return false
    if (ui.isRetrying || ui.retry.phase === "waiting" || ui.retry.phase === "running") return false
    if (ui.pendingMessageCount > 0) return false
    if (ui.queue.steering.length > 0 || ui.queue.followUp.length > 0) return false
    // An open dialog is waiting on a human, so the runtime must stay.
    for (const request of this.extensionUiPending.values()) {
      if (request.sessionId === session.id) return false
    }
    return true
  }

  /** Exposed for tests; the sweep also runs on a timer. */
  async reclaimIdleRuntimes(now = Date.now()): Promise<string[]> {
    if (this.idleRuntimeTimeoutMs <= 0) return []
    const reclaimed: string[] = []
    for (const session of [...this.byId.values()]) {
      if (!session.real) continue
      const idleFor = now - (this.lastActivity.get(session.id) ?? 0)
      if (idleFor < this.idleRuntimeTimeoutMs) continue
      if (!this.isRuntimeReclaimable(session)) continue
      try {
        await this.detachRuntime(session)
      } catch {
        continue
      }
      this.lastActivity.delete(session.id)
      reclaimed.push(session.id)
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.snapshot.updated",
        { sessionId: session.id, reason: "runtime", snapshot: this.snapshot(session) },
      )
    }
    return reclaimed
  }

  /** Drops the runtime but keeps the session record, so a later attach reopens it. */
  private async detachRuntime(session: AppSession): Promise<void> {
    const runtime = session.real
    if (runtime) session.nativeHead = runtime.getNativeHead()
    this.unbindRuntime(session)
    session.real = undefined
    session.workerGeneration = undefined
    if (runtime) await this.disposeRuntime(runtime)
    this.touch(session)
  }

  private unbindRuntime(session: AppSession): void {
    const binding = this.runtimeBindings.get(session.id)
    if (!binding) return
    this.runtimeBindings.delete(session.id)
    binding.unsubscribe()
    this.closeExtensionUi(session.id, "session_replaced", session.workerGeneration)
  }

  private closeExtensionUi(
    sessionId: string,
    reason: ExtensionUiSettlementReasonV1,
    generation?: string,
  ): void {
    for (const [requestId, request] of this.extensionUiPending) {
      if (request.sessionId !== sessionId) continue
      if (generation && request.workerGeneration !== generation) continue
      this.extensionUiPending.delete(requestId)
      if (this.rememberExtensionUiSettlement(requestId, sessionId, reason)) {
        this.eventHub?.publishV2(
          { kind: "session", id: sessionId },
          "extension.ui.settled",
          { requestId, sessionId, reason },
        )
      }
    }
    this.extensionUiStates.delete(sessionId)
  }

  async getNativeEntriesPage(sessionId: string, cursor: string | undefined, limit: number, maxBytes: number) {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (runtime) return runtime.getNativeEntriesPage(cursor, limit, maxBytes)
    const head = mockNativeHead(session)
    return nativeEntriesPageFromEntries(head, session.nativeEntries, { cursor, limit, maxBytes }, entry => entry)
  }

  async getNativeBranchPage(sessionId: string, cursor: string | undefined, limit: number, maxBytes: number) {
    const session = await this.attach(sessionId)
    if (session.real) return session.real.getNativeBranchPage(cursor, limit, maxBytes)
    const head = mockNativeHead(session)
    const byId = new Map(session.nativeEntries.flatMap(entry =>
      typeof entry.id === "string" ? [[entry.id, entry] as const] : []
    ))
    const branch: NativeEntry[] = []
    const visited = new Set<string>()
    let id = head.leafId
    while (id && !visited.has(id)) {
      visited.add(id)
      const entry = byId.get(id)
      if (!entry) break
      branch.push(entry)
      id = typeof entry.parentId === "string" ? entry.parentId : null
    }
    branch.reverse()
    return nativeEntriesPageFromEntries(head, branch, {
      cursor,
      limit,
      maxBytes,
      checkpoint: cursor ? undefined : {
        position: { epoch: session.epoch, sequence: session.sequence },
      },
    }, entry => entry)
  }

  async getNativeTree(sessionId: string) {
    const session = await this.attach(sessionId)
    if (session.real) return session.real.getNativeTree()
    const byId = new Map<string, MockTreeNode>()
    for (const entry of session.nativeEntries) {
      if (typeof entry.id === "string") byId.set(entry.id, { entry, children: [] })
    }
    const roots: MockTreeNode[] = []
    for (const node of byId.values()) {
      const parentId = typeof node.entry.parentId === "string" ? node.entry.parentId : undefined
      const parent = parentId ? byId.get(parentId) : undefined
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    return roots as unknown as Array<{ [key: string]: PiNativeJsonValueV1 }>
  }

  async getNativeImageAttachment(sessionId: string, entryId: string, blockIndex: number) {
    const session = await this.attach(sessionId)
    const runtime = session.real
    if (!runtime) throw sessionRuntimeUnavailable(session)
    const attachment = await runtime.getNativeImageAttachment(entryId, blockIndex)
    return { ...attachment, data: Buffer.from(attachment.data, "base64") }
  }

  private rememberExtensionUiSettlement(
    requestId: string,
    sessionId: string,
    reason: ExtensionUiSettlementReasonV1,
    response?: ExtensionUiDialogResponseV1,
  ): boolean {
    const previous = this.extensionUiSettled.get(requestId)
    this.extensionUiSettled.delete(requestId)
    this.extensionUiSettled.set(requestId, {
      sessionId,
      reason,
      response: response ?? previous?.response,
    })
    while (this.extensionUiSettled.size > 256) {
      const oldest = this.extensionUiSettled.keys().next().value as string | undefined
      if (!oldest) break
      this.extensionUiSettled.delete(oldest)
    }
    return previous === undefined
  }

  private disposeRuntime(runtime: PiSessionRuntime): Promise<void> {
    const existing = this.runtimeDisposals.get(runtime)
    if (existing) return existing
    const disposing = runtime.dispose()
    this.runtimeDisposals.set(runtime, disposing)
    return disposing
  }

  private async discover(cwd?: string): Promise<void> {
    if (this.driver !== "pi") return
    const allKey = "*"
    const key = cwd ?? allKey
    const now = Date.now()
    const allPending = this.discovering.get(allKey)
    if (allPending) return allPending
    if (cwd && now - (this.discoveredAt.get(allKey) ?? 0) < DISCOVERY_TTL_MS) return
    if (now - (this.discoveredAt.get(key) ?? 0) < DISCOVERY_TTL_MS) return

    const existing = this.discovering.get(key)
    if (existing) return existing

    const pending = this.scanDiscovered(cwd).finally(() => {
      if (this.discovering.get(key) === pending) this.discovering.delete(key)
    })
    this.discovering.set(key, pending)
    return pending
  }

  private async scanDiscovered(cwd?: string): Promise<void> {
    const backend = await this.getBackend()
    const infos = cwd && backend.list ? await backend.list(cwd) : await backend.listAll()
    const seen = new Set(infos.map(info => info.id))
    for (const info of infos) this.addDiscovered(info)

    const scopeKey = cwd ? workspacePathKey(this.workspaces.resolve(cwd).canonicalRoot) : undefined
    for (const [id, session] of this.byId) {
      if (session.driver !== "pi" || session.real || seen.has(id)) continue
      if (!scopeKey || workspacePathKey(session.cwd) === scopeKey) this.byId.delete(id)
    }
    this.discoveredAt.set(cwd ?? "*", Date.now())
  }

  private publishResourcesUpdated(cwd: string, revision: string = randomUUID()): void {
    if (this.resourceEventCoalescing > 0) {
      this.coalescedResourceWorkspaces.add(cwd)
      return
    }
    this.eventHub?.publishV2(
      { kind: "resources", id: cwd },
      "resources.updated",
      { workspacePath: cwd, revision },
    )
  }

  /**
   * Reloading resources for N attached sessions makes each runtime emit its own
   * resourcesChanged event. Without coalescing a single settings change would
   * publish N+1 events carrying different revisions.
   */
  private async withCoalescedResourceEvents<T>(
    cwd: string,
    run: () => Promise<T>,
    revision: string = randomUUID(),
  ): Promise<T> {
    this.resourceEventCoalescing += 1
    try {
      return await run()
    } finally {
      this.resourceEventCoalescing -= 1
      if (this.resourceEventCoalescing === 0) {
        const pending = [...this.coalescedResourceWorkspaces]
        this.coalescedResourceWorkspaces.clear()
        for (const pendingCwd of new Set([cwd, ...pending])) {
          this.publishResourcesUpdated(pendingCwd, revision)
        }
      }
    }
  }

  private async getBackend(): Promise<PiSessionBackend> {
    const backend = this.injectedBackend ?? await (this.backendPromise ??= import("./runtime-supervisor.ts").then(({ RuntimeSupervisor }) => {
      return new RuntimeSupervisor()
    }))
    if (this.providerAuthBackend !== backend) {
      this.providerAuthUnsubscribe?.()
      this.packageProgressUnsubscribe?.()
      this.providerAuthBackend = backend
      this.providerAuthUnsubscribe = backend.onProviderAuth?.(event => {
        this.eventHub?.publishV2(
          { kind: "provider", id: event.providerId },
          "provider.auth.flow",
          event,
        )
        if (event.type === "completed") {
          this.eventHub?.publishV2(
            { kind: "provider", id: event.providerId },
            "provider.auth.updated",
            { providerId: event.providerId, authenticated: true },
          )
        }
      })
      this.packageProgressUnsubscribe = backend.onPackageProgress?.(event => {
        // The worker echoes the server-generated progress id, so map it back to
        // the workspace and the commandId the client actually submitted.
        const tracked = this.packageCommandWorkspaces.get(event.commandId)
        const workspacePath = tracked?.cwd ?? event.workspacePath
        this.eventHub?.publishV2(
          { kind: "resources", id: workspacePath ?? "global" },
          "packages.progress",
          { ...event, commandId: tracked?.commandId ?? event.commandId, workspacePath },
        )
      })
    }
    return backend
  }

  private addDiscovered(info: PiSessionInfo): void {
    if (this.hiddenIds.has(info.id) || !info.cwd) return
    let cwd: string
    try {
      cwd = this.workspaces.resolve(info.cwd).canonicalRoot
    } catch {
      return
    }
    const existing = this.byId.get(info.id)
    if (existing) {
      if (!existing.real) {
        existing.cwd = cwd
        existing.title = info.name ?? (info.firstMessage.slice(0, 48) || "New chat")
        existing.parentSessionPath = info.parentSessionPath
        existing.createdAt = info.createdAt
        existing.updatedAt = info.updatedAt
        existing.sessionFile = info.path
      }
      return
    }
    this.byId.set(info.id, {
      id: info.id,
      cwd,
      driverSessionId: info.id,
      title: info.name ?? (info.firstMessage.slice(0, 48) || "New chat"),
      parentSessionPath: info.parentSessionPath,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      epoch: randomUUID(),
      sequence: 0,
      nativeEntries: [],
      driver: "pi",
      sessionFile: info.path,
    })
  }

  async dispose(): Promise<void> {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = undefined
    }
    this.providerAuthUnsubscribe?.()
    this.providerAuthUnsubscribe = undefined
    this.packageProgressUnsubscribe?.()
    this.packageProgressUnsubscribe = undefined
    for (const session of this.byId.values()) this.unbindRuntime(session)
    await Promise.all([
      ...[...this.byId.values()].map(async session => {
        try {
          if (session.real) await this.disposeRuntime(session.real)
        } catch {
          /* best effort while the HTTP server is closing */
        }
      }),
      (async () => {
        try {
          const backend = this.injectedBackend ?? (this.backendPromise ? await this.backendPromise : undefined)
          await backend?.dispose?.()
        } catch {
          /* best effort while the HTTP server is closing */
        }
      })(),
    ])
  }

  snapshot(session: AppSession): SessionSnapshotV1 {
    const ui = session.real?.getRuntimeUiState()
    const model = ui?.model ?? session.real?.getModel()
    const isStreaming = !session.runtimeError &&
      Boolean(ui?.isStreaming || session.real?.isStreaming())
    const isCompacting = !session.runtimeError && (ui?.isCompacting ?? false)
    let state: SessionSnapshotV1["session"]["state"] = "idle"
    if (session.runtimeError) state = "crashed"
    else if (isCompacting) state = "compacting"
    else if (ui?.retry?.phase === "waiting" || ui?.retry?.phase === "running") state = "retrying"
    else if (isStreaming) state = "running"

    const native = session.real?.getNativeHead() ?? session.nativeHead ?? mockNativeHead(session)
    if (session.real) session.nativeHead = native
    return {
      protocolVersion: 1,
      epoch: session.epoch,
      sequence: session.sequence,
      session: {
        id: session.id,
        directory: session.cwd,
        driverId: "pi",
        driverSessionId: session.driverSessionId,
        title: session.title,
        state,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      runtime: {
        attached: session.driver === "mock" || Boolean(session.real),
        model: model
          ? { provider: model.provider, id: model.id, displayName: model.displayName }
          : session.driver === "mock"
            ? { provider: "mock", id: "mock", displayName: "Mock" }
            : undefined,
        thinkingLevel: ui?.thinkingLevel ?? session.real?.getThinkingLevel() ?? "off",
        availableThinkingLevels:
          ui?.availableThinkingLevels ??
          (session.real
            ? session.real.getAvailableThinkingLevels()
            : ["off", "minimal", "low", "medium", "high"]),
        isStreaming,
        isCompacting,
        isBashRunning: !session.runtimeError && (ui?.isBashRunning ?? false),
        hasPendingBashMessages: !session.runtimeError && (ui?.hasPendingBashMessages ?? false),
        isRetrying: !session.runtimeError && (ui?.isRetrying ?? false),
        retryAttempt: ui?.retryAttempt ?? 0,
        pendingMessageCount: ui?.pendingMessageCount ?? 0,
        queue: ui?.queue ?? {
          steering: [],
          followUp: [],
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
        },
        retry: ui?.retry ?? { phase: "idle", autoEnabled: false },
        compaction: ui?.compaction ?? {
          autoEnabled: false,
          operation: { type: "none" },
        },
        contextUsage: ui?.contextUsage,
        sessionStats: ui?.sessionStats,
        scopedModels: ui?.scopedModels,
        tools: ui?.tools ?? [],
        activeTools: ui?.activeTools ?? [],
        workerGeneration: session.workerGeneration,
        runtimeError: session.runtimeError,
      },
      native,
    }
  }
}

function emptyNativeHead(leafId: string | null): PiNativeSessionHeadV1 {
  return {
    namespace: "pi",
    schemaVersion: 1,
    sdkVersion: "mock",
    revision: 0,
    epoch: "mock",
    header: null,
    leafId,
    entryCount: 0,
  }
}

function mockNativeHead(session: AppSession): PiNativeSessionHeadV1 {
  const leaf = session.nativeEntries.at(-1)
  return {
    namespace: "pi",
    schemaVersion: 1,
    sdkVersion: "mock",
    revision: session.sequence,
    epoch: session.epoch,
    header: null,
    leafId: typeof leaf?.id === "string" ? leaf.id : null,
    entryCount: session.nativeEntries.length,
  }
}

function appendMockTurnEntries(
  entries: NativeEntry[],
  turn: {
    userText: string
    assistantText: string
    thinking?: string
    tool?: { name: string; args: unknown; result: string; isError?: boolean }
  },
): number {
  const timestamp = Date.now()
  const parentId = typeof entries.at(-1)?.id === "string" ? String(entries.at(-1)?.id) : null
  const userId = `mock-user-${randomUUID()}`
  const assistantId = `mock-assistant-${randomUUID()}`
  entries.push({
    type: "message",
    id: userId,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "user", timestamp, content: turn.userText },
  })
  const content: PiNativeJsonValueV1[] = []
  if (turn.thinking) content.push({ type: "thinking", thinking: turn.thinking })
  if (turn.assistantText) content.push({ type: "text", text: turn.assistantText })
  const toolCallId = turn.tool ? `mock-tool-${randomUUID()}` : undefined
  if (turn.tool && toolCallId) {
    content.push({ type: "toolCall", id: toolCallId, name: turn.tool.name, arguments: turn.tool.args as PiNativeJsonValueV1 })
  }
  entries.push({
    type: "message",
    id: assistantId,
    parentId: userId,
    timestamp: new Date(timestamp + 1).toISOString(),
    message: {
      role: "assistant",
      timestamp: timestamp + 1,
      provider: "mock",
      model: "mock",
      stopReason: toolCallId ? "toolUse" : "stop",
      content,
    },
  })
  if (turn.tool && toolCallId) {
    entries.push({
      type: "message",
      id: `mock-result-${randomUUID()}`,
      parentId: assistantId,
      timestamp: new Date(timestamp + 2).toISOString(),
      message: {
        role: "toolResult",
        timestamp: timestamp + 2,
        toolCallId,
        toolName: turn.tool.name,
        isError: turn.tool.isError === true,
        content: [{ type: "text", text: turn.tool.result }],
      },
    })
    return 3
  }
  return 2
}

function runtimeReplacedError(): Error {
  return Object.assign(new Error("Pi runtime was replaced before the command completed"), {
    code: "SESSION_RUNTIME_CRASHED",
  })
}

function unsupportedRuntimeOperation(operation: string): Error {
  return Object.assign(new Error(`Pi runtime does not support ${operation}`), { code: "CAPABILITY_DISABLED" })
}

function sessionRuntimeUnavailable(session: AppSession): Error {
  return Object.assign(new Error(`session runtime is unavailable: ${session.id}`), { code: "SESSION_NOT_RUNNING" })
}

function sameSessionFile(sourceFile?: string, targetFile?: string): boolean {
  if (!sourceFile || !targetFile) return false
  const sourcePath = path.resolve(sourceFile)
  const targetPath = path.resolve(targetFile)
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
  if (normalize(sourcePath) === normalize(targetPath)) return true
  try {
    if (normalize(realpathSync.native(sourcePath)) === normalize(realpathSync.native(targetPath))) return true
    const sourceStats = statSync(sourcePath, { bigint: true })
    const targetStats = statSync(targetPath, { bigint: true })
    return sourceStats.ino !== 0n && sourceStats.dev === targetStats.dev && sourceStats.ino === targetStats.ino
  } catch {
    return false
  }
}
