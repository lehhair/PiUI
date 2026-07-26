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
  PiSessionEntryV1,
  PiSessionTreeNodeV1,
  QueueDeliveryModeV1,
  SessionAttachmentV2,
  SessionReplacementResultV1,
  SessionExportResultV2,
  SessionSnapshotV1,
  TimelineItemV1,
} from "@piui/protocol"
import {
  applyWorkerEvent,
  createProjectionState,
  getDriverMode,
  runMockTurn,
  type DriverMode,
  type PiModelInfo,
  type PiSessionInfo,
  type PiSessionRuntime,
  type ProjectionState,
} from "@piui/pi-worker"
import type { WorkspaceStore } from "./workspace-store.ts"
import type { EventHub } from "./event-hub.ts"
import { preparePromptInput } from "./prompt-attachments.ts"
import { resolveWorkspacePath } from "./path-safety.ts"

export interface AppSession {
  id: string
  workspaceId: string
  driverSessionId: string
  title: string
  createdAt: string
  updatedAt: string
  epoch: string
  sequence: number
  projection: ProjectionState
  driver: DriverMode
  sessionFile?: string
  real?: PiSessionRuntime
  workerGeneration?: string
  runtimeError?: string
  nativeEntries?: PiSessionEntryV1[]
  nativeTree?: PiSessionTreeNodeV1[]
  nativeLeafId?: string | null
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
  resolvePackages?(cwd: string, missingAction?: "skip" | "error"): Promise<ResolvedPackageResourcesV1>
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

function emptyExtensionUiState(): ExtensionUiStateV1 {
  return {
    revision: 0,
    statuses: {},
    workingVisible: true,
    widgets: {},
    editorText: "",
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
  private readonly extensionUiPending = new Map<string, ExtensionUiDialogRequestV1>()
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
  private readonly packageCommandWorkspaces = new Map<string, string>()

  constructor(
    private readonly workspaces: WorkspaceStore,
    driver: DriverMode = getDriverMode(),
    private readonly injectedBackend?: PiSessionBackend,
    private readonly eventHub?: EventHub,
    private readonly onRuntimeCrash?: (sessionId: string, workerGeneration: string | undefined, error: Error) => void,
  ) {
    this.driver = driver
  }

  private resourceEventCoalescing = 0
  private readonly coalescedResourceWorkspaces = new Set<string>()

  getDriver(): DriverMode {
    return this.driver
  }

  async list(workspaceId?: string): Promise<AppSession[]> {
    if (workspaceId) {
      const workspace = this.workspaces.get(workspaceId)
      if (!workspace) return []
      await this.discover(workspace.canonicalRoot)
    } else {
      await this.discover()
    }
    const all = [...this.byId.values()]
    return workspaceId ? all.filter(s => s.workspaceId === workspaceId) : all
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

  async getSettings(workspaceId: string): Promise<PiSettingsSnapshotV1> {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
    const backend = await this.getBackend()
    if (!backend.getSettings) throw unsupportedRuntimeOperation("settings")
    return backend.getSettings(workspace.canonicalRoot)
  }

  async patchSettings(workspaceId: string, patch: PiSettingsPatchV1): Promise<PiSettingsSnapshotV1> {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
    const backend = await this.getBackend()
    if (!backend.patchSettings) throw unsupportedRuntimeOperation("settings")
    const result = await backend.patchSettings(workspace.canonicalRoot, patch)
    await this.withCoalescedResourceEvents(workspaceId, () => Promise.all([...this.byId.values()]
      .filter(session => session.workspaceId === workspaceId && session.real)
      .map(session => this.reloadResources(session.id, false))))
    return result
  }

  async getProjectTrust(workspaceId: string): Promise<ProjectTrustV1> {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
    const backend = await this.getBackend()
    if (!backend.getProjectTrust) throw unsupportedRuntimeOperation("project trust")
    return backend.getProjectTrust(workspace.canonicalRoot)
  }

  async setProjectTrust(workspaceId: string, decision: boolean | null): Promise<ProjectTrustV1> {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
    const backend = await this.getBackend()
    if (!backend.setProjectTrust) throw unsupportedRuntimeOperation("project trust")
    const result = await backend.setProjectTrust(workspace.canonicalRoot, decision)
    const detached: AppSession[] = []
    for (const session of [...this.byId.values()].filter(value => value.workspaceId === workspaceId && value.real)) {
      const runtime = session.real
      this.unbindRuntime(session)
      session.real = undefined
      session.workerGeneration = undefined
      if (runtime) await this.disposeRuntime(runtime)
      this.touch(session)
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
        { kind: "workspace", id: workspaceId },
        "workspace.sessions.updated",
        { workspaceId },
      )
    }
    this.publishResourcesUpdated(workspaceId)
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
    this.eventHub?.publishV2(
      { kind: "provider", id: providerId },
      "provider.auth.updated",
      { providerId, authenticated: false },
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
  }

  async removeRuntimeApiKey(providerId: string): Promise<void> {
    const backend = await this.getBackend()
    if (!backend.removeRuntimeApiKey) throw unsupportedRuntimeOperation("runtime API keys")
    await backend.removeRuntimeApiKey(providerId)
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

  async listPackages(workspaceId: string): Promise<ConfiguredPackageV1[]> {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
    const backend = await this.getBackend()
    if (!backend.listPackages) throw unsupportedRuntimeOperation("packages")
    return backend.listPackages(workspace.canonicalRoot)
  }

  async managePackage(
    workspaceId: string,
    commandId: string,
    action: "install" | "remove" | "update",
    source?: string,
    local?: boolean,
    persist?: boolean,
  ): Promise<ConfiguredPackageV1[]> {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
    const backend = await this.getBackend()
    if (!backend.managePackage) throw unsupportedRuntimeOperation("packages")
    this.packageCommandWorkspaces.set(commandId, workspaceId)
    let packages: ConfiguredPackageV1[]
    try {
      packages = await backend.managePackage(workspace.canonicalRoot, commandId, action, source, local, persist)
    } finally {
      this.packageCommandWorkspaces.delete(commandId)
    }
    await this.withCoalescedResourceEvents(
      workspaceId,
      () => Promise.all([...this.byId.values()]
        .filter(session => session.workspaceId === workspaceId && session.real)
        .map(session => this.reloadResources(session.id, false))),
      commandId,
    )
    return packages
  }

  async resolvePackages(workspaceId: string, missingAction?: "skip" | "error"): Promise<ResolvedPackageResourcesV1> {
    const workspace = this.requireWorkspace(workspaceId)
    const backend = await this.getBackend()
    if (!backend.resolvePackages) throw unsupportedRuntimeOperation("package resolution")
    return backend.resolvePackages(workspace.canonicalRoot, missingAction)
  }

  async resolveExtensionSources(
    workspaceId: string,
    sources: string[],
    options?: { local?: boolean; temporary?: boolean },
  ): Promise<ResolvedPackageResourcesV1> {
    const workspace = this.requireWorkspace(workspaceId)
    const backend = await this.getBackend()
    if (!backend.resolveExtensionSources) throw unsupportedRuntimeOperation("extension source resolution")
    return backend.resolveExtensionSources(workspace.canonicalRoot, sources, options)
  }

  async changePackageSource(
    workspaceId: string,
    source: string,
    operation: "add" | "remove",
    local?: boolean,
  ): Promise<{ changed: boolean; packages: ConfiguredPackageV1[] }> {
    const workspace = this.requireWorkspace(workspaceId)
    const backend = await this.getBackend()
    if (!backend.changePackageSource) throw unsupportedRuntimeOperation("package settings")
    const result = await backend.changePackageSource(workspace.canonicalRoot, source, operation, local)
    await this.withCoalescedResourceEvents(workspaceId, () => Promise.all([...this.byId.values()]
      .filter(session => session.workspaceId === workspaceId && session.real)
      .map(session => this.reloadResources(session.id, false))))
    return result
  }

  async getInstalledPackagePath(
    workspaceId: string,
    source: string,
    scope: "user" | "project",
  ): Promise<string | undefined> {
    const workspace = this.requireWorkspace(workspaceId)
    const backend = await this.getBackend()
    if (!backend.getInstalledPackagePath) throw unsupportedRuntimeOperation("package path")
    return backend.getInstalledPackagePath(workspace.canonicalRoot, source, scope)
  }

  async checkPackageUpdates(workspaceId: string): Promise<PackageUpdateV1[]> {
    const workspace = this.requireWorkspace(workspaceId)
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
      state: structuredClone(this.extensionUiStates.get(sessionId) ?? emptyExtensionUiState()),
      pending: [...this.extensionUiPending.values()]
        .filter(request => request.sessionId === sessionId)
        .map(request => ({ ...request, options: request.options ? [...request.options] : undefined })),
    }
  }

  async respondExtensionUi(
    sessionId: string,
    requestId: string,
    response: ExtensionUiDialogResponseV1,
    workerGeneration?: string,
  ): Promise<void> {
    const request = this.extensionUiPending.get(requestId)
    if (!request || request.sessionId !== sessionId) {
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
    this.eventHub?.publishV2(
      { kind: "session", id: sessionId },
      "extension.ui.cancelled",
      { requestId, reason: "responded" },
    )
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
    workspaceId: string,
    opts?: { title?: string; seedMock?: boolean },
  ): Promise<AppSession> {
    const ws = this.workspaces.get(workspaceId)
    if (!ws) {
      throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" as const })
    }
    const now = new Date().toISOString()
    let projection = createProjectionState()
    let sequence = 0
    let real: PiSessionRuntime | undefined
    let driverSessionId = `mock-${randomUUID().slice(0, 8)}`

    if (this.driver === "pi") {
      const backend = await this.getBackend()
      real = await backend.open(ws.canonicalRoot)
      driverSessionId = real.getSessionId()
      projection = real.getProjection()
    } else if (opts?.seedMock === true) {
      for (const ev of runMockTurn({
        userText: "hello from mock",
        assistantText: "this is a mock assistant reply",
        thinking: "mock think",
        tool: { name: "read", args: { path: "README.md" }, result: "# mock\n" },
      })) {
        projection = applyWorkerEvent(projection, ev)
        sequence++
      }
    }

    const seedMock = opts?.seedMock === true && this.driver === "mock"
    const session: AppSession = {
      id: driverSessionId,
      workspaceId,
      driverSessionId,
      title: opts?.title ?? (seedMock ? "Mock session" : "New chat"),
      createdAt: now,
      updatedAt: now,
      epoch: randomUUID(),
      sequence,
      projection,
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
    },
  ): Promise<AppSession> {
    const session = await this.attach(sessionId)
    const workspace = this.workspaces.get(session.workspaceId)
    if (!workspace) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" as const })
    const prepared = preparePromptInput(workspace.canonicalRoot, text, opts?.attachments)
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
          return runtime.prompt(trimmed, prepared.images)
        })
      } catch (e) {
        if (!this.isCurrentRuntime(session, runtime, generation)) throw runtimeReplacedError()
        const msg = e instanceof Error ? e.message : String(e)
        const code = e && typeof e === "object" && "code" in e ? String(e.code) : "INTERNAL"
        throw Object.assign(new Error(msg), { code })
      }
      if (!this.isCurrentRuntime(session, runtime, generation)) throw runtimeReplacedError()
      session.projection = runtime.getProjection()
      session.sessionFile = runtime.getSessionFile() ?? session.sessionFile
      session.title = runtime.getSessionName() ?? session.title
      session.sequence += 1
      session.updatedAt = new Date().toISOString()
      opts?.onTick?.(session)
      return session
    }

    // mock path — no LLM
    let projection = session.projection
    const events = runMockTurn({
      userText: trimmed,
      assistantText: `mock reply: ${trimmed.slice(0, 200)}`,
      thinking: "mock thinking",
    })
    const delay = opts?.stream ? (opts.delayMs ?? 25) : 0
    for (const ev of events) {
      projection = applyWorkerEvent(projection, ev)
      session.sequence += 1
      session.projection = projection
      session.updatedAt = new Date().toISOString()
      opts?.onTick?.(session)
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
    }
    session.sequence += 1
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
    const workspace = this.workspaces.get(session.workspaceId)
    if (!workspace) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" as const })
    const prepared = preparePromptInput(workspace.canonicalRoot, text, attachments)
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
    const workspace = this.workspaces.get(session.workspaceId)
    if (!workspace) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" as const })
    const prepared = preparePromptInput(workspace.canonicalRoot, text, options?.attachments)
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
    session.projection = runtime.getProjection()
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
      session.projection = runtime.getProjection()
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
    session.projection = runtime.getProjection()
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
    const workspace = this.workspaces.get(session.workspaceId)
    if (!workspace) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
    const safeId = session.id.replace(/[^A-Za-z0-9._-]/g, "-")
    const relative = outputPath?.trim() || `pi-session-${safeId}.${format}`
    const resolved = resolveWorkspacePath(workspace.canonicalRoot, relative)
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
    session.projection = runtime.getProjection()
    session.nativeEntries = runtime.getEntries()
    session.nativeTree = runtime.getTree()
    session.nativeLeafId = runtime.getLeafId()
    this.touch(session)
    if (publish !== false) {
      this.publishResourcesUpdated(session.workspaceId, typeof publish === "string" ? publish : undefined)
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
    session.projection = runtime.getProjection()
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
    session.nativeEntries = runtime.getEntries()
    session.nativeTree = runtime.getTree()
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
    this.publishResourcesUpdated(session.workspaceId)
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
      session.projection = runtime.getProjection()
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
    session.projection = runtime.getProjection()
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
    return this.replaceSession(sessionId, runtime => runtime.fork(entryId, position))
  }

  cloneSession(
    sessionId: string,
    entryId?: string,
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    return this.replaceSession(sessionId, runtime => runtime.clone(entryId))
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
    const workspace = this.workspaces.get(target.workspaceId)
    return this.replaceSession(
      sessionId,
      runtime => runtime.switchSession(target.sessionFile!, workspace?.canonicalRoot),
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
    options: { existingTargetId?: string } = {},
  ): Promise<{ source: AppSession; target: AppSession; replacement: SessionReplacementResultV1 }> {
    const source = await this.attach(sessionId)
    const runtime = source.real
    if (!runtime) throw unsupportedRuntimeOperation("session replacement")
    const sourceProjection = source.projection
    const sourceGeneration = source.workerGeneration
    source.nativeEntries = runtime.getEntries()
    source.nativeTree = runtime.getTree()
    source.nativeLeafId = runtime.getLeafId()
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
    return this.commitReplacement(source, runtime, sourceProjection, sourceGeneration, replacement, options)
  }

  private async commitReplacement(
    source: AppSession,
    runtime: PiSessionRuntime,
    sourceProjection: ProjectionState,
    sourceGeneration: string | undefined,
    replacement: SessionReplacementResultV1,
    options: { existingTargetId?: string } = {},
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
      source.projection = sourceProjection
      this.touch(source)

      let workspaceId = source.workspaceId
      if (replacement.targetCwd) workspaceId = this.workspaces.register(replacement.targetCwd).id
      const now = new Date().toISOString()
      const target: AppSession = existingTarget ?? {
        id: targetId,
        workspaceId,
        driverSessionId: targetId,
        title: runtime.getSessionName() ?? `${source.title} fork`,
        createdAt: now,
        updatedAt: now,
        epoch: randomUUID(),
        sequence: 0,
        projection: runtime.getProjection(),
        driver: "pi",
        sessionFile: targetSessionFile,
      }
      target.workspaceId = workspaceId
      target.sessionFile = targetSessionFile
      target.projection = runtime.getProjection()
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
      source.projection = sourceProjection
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
    const workspace = this.workspaces.get(session.workspaceId)
    if (!workspace) {
      throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
    }
    const backend = await this.getBackend()
    return backend.open(workspace.canonicalRoot, session.sessionFile)
  }

  private bindRuntime(session: AppSession, runtime: PiSessionRuntime): void {
    this.unbindRuntime(session)
    session.real = runtime
    session.projection = runtime.getProjection()
    session.driverSessionId = runtime.getSessionId()
    session.sessionFile = runtime.getSessionFile() ?? session.sessionFile
    session.title = runtime.getSessionName() ?? session.title
    session.workerGeneration = runtime.getWorkerGeneration?.()
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
      if (!this.isCurrentRuntime(session, runtime, generation)) return
      session.sequence += 1
      session.updatedAt = new Date().toISOString()
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.snapshot.updated",
        { sessionId: session.id, reason: "runtime", snapshot: this.snapshot(session) },
      )
    })
    let initialProjection = true
    const unsubscribeProjection = runtime.onProjection?.(projection => {
      if (initialProjection) {
        initialProjection = false
        return
      }
      if (!this.isCurrentRuntime(session, runtime, generation)) return
      session.projection = projection
    })
    const unsubscribeProjectionDelta = runtime.onProjectionDelta?.(projection => {
      if (!this.isCurrentRuntime(session, runtime, generation)) return
      this.touch(session)
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.timeline.delta",
        {
          sessionId: session.id,
          epoch: session.epoch,
          sequence: session.sequence,
          items: projection.timeline,
          removedItemIds: projection.removedItemIds,
          isStreaming: projection.isStreaming,
        },
      )
    })
    const unsubscribeNativeEvent = runtime.onNativeEvent?.(event => {
      if (!this.isCurrentRuntime(session, runtime, generation)) return
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "session.native.event",
        { sessionId: session.id, event },
      )
    })
    const unsubscribeProviderAuth = runtime.onProviderAuth?.(event => {
      if (!this.isCurrentRuntime(session, runtime, generation)) return
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "provider.auth.flow",
        event,
      )
    })
    const unsubscribeResourcesChanged = runtime.onResourcesChanged?.(() => {
      if (!this.isCurrentRuntime(session, runtime, generation)) return
      this.publishResourcesUpdated(session.workspaceId)
    })
    const unsubscribeExtensionUi = runtime.onExtensionUi?.(event => {
      if (!this.isCurrentRuntime(session, runtime, generation)) return
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
      if (event.type === "cancelled") {
        this.extensionUiPending.delete(event.requestId)
        this.eventHub?.publishV2(
          { kind: "session", id: session.id },
          "extension.ui.cancelled",
          { requestId: event.requestId, reason: event.reason },
        )
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
      this.eventHub?.publishV2(
        { kind: "session", id: session.id },
        "extension.ui.editor.command",
        { sessionId: session.id, command: event.command },
      )
    })
    const unsubscribeCrash = runtime.onCrash?.(error => {
      if (!this.isCurrentRuntime(session, runtime, generation)) return
      this.runtimeBindings.delete(session.id)
      binding.unsubscribe()
      this.closeExtensionUi(session.id, "runtime_crashed", generation)
      session.real = undefined
      session.runtimeError = error.message
      session.projection = {
        ...session.projection,
        isStreaming: false,
        timeline: session.projection.timeline.map(item =>
          item.type === "assistant" && item.status === "streaming"
            ? { ...item, status: "error", stopReason: item.stopReason ?? "error" }
            : item,
        ),
      }
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
    binding.unsubscribe = () => {
      unsubscribeState?.()
      unsubscribeProjection?.()
      unsubscribeProjectionDelta?.()
      unsubscribeNativeEvent?.()
      unsubscribeProviderAuth?.()
      unsubscribeResourcesChanged?.()
      unsubscribeExtensionUi?.()
      unsubscribeCrash?.()
    }
    const initialization = runtime.initializeExtensions?.() ?? Promise.resolve()
    this.extensionInitializations.set(runtime, initialization)
    void initialization.catch(error => {
      if (!this.isCurrentRuntime(session, runtime, generation)) return
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
    } else {
      next = { ...next, title: patch.title }
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
    if (!this.isCurrentRuntime(session, runtime, generation)) throw runtimeReplacedError()
    return result
  }

  private unbindRuntime(session: AppSession): void {
    const binding = this.runtimeBindings.get(session.id)
    if (!binding) return
    this.runtimeBindings.delete(session.id)
    binding.unsubscribe()
    this.closeExtensionUi(session.id, "runtime_replaced", session.workerGeneration)
  }

  private closeExtensionUi(sessionId: string, reason: string, generation?: string): void {
    for (const [requestId, request] of this.extensionUiPending) {
      if (request.sessionId !== sessionId) continue
      if (generation && request.workerGeneration !== generation) continue
      this.extensionUiPending.delete(requestId)
      this.eventHub?.publishV2(
        { kind: "session", id: sessionId },
        "extension.ui.cancelled",
        { requestId, reason },
      )
    }
    this.extensionUiStates.delete(sessionId)
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

    const workspaceId = cwd ? this.workspaces.register(cwd).id : undefined
    for (const [id, session] of this.byId) {
      if (session.driver !== "pi" || session.real || seen.has(id)) continue
      if (!workspaceId || session.workspaceId === workspaceId) this.byId.delete(id)
    }
    this.discoveredAt.set(cwd ?? "*", Date.now())
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
    return workspace
  }

  private publishResourcesUpdated(workspaceId: string, revision: string = randomUUID()): void {
    if (this.resourceEventCoalescing > 0) {
      this.coalescedResourceWorkspaces.add(workspaceId)
      return
    }
    this.eventHub?.publishV2(
      { kind: "resources", id: workspaceId },
      "resources.updated",
      { workspaceId, revision },
    )
  }

  /**
   * Reloading resources for N attached sessions makes each runtime emit its own
   * resourcesChanged event. Without coalescing a single settings change would
   * publish N+1 events carrying different revisions.
   */
  private async withCoalescedResourceEvents<T>(
    workspaceId: string,
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
        for (const pendingWorkspaceId of new Set([workspaceId, ...pending])) {
          this.publishResourcesUpdated(pendingWorkspaceId, revision)
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
        const workspace = event.workspaceId ?? this.packageCommandWorkspaces.get(event.commandId)
        this.eventHub?.publishV2(
          { kind: "resources", id: workspace ?? "global" },
          "packages.progress",
          { ...event, workspaceId: workspace },
        )
      })
    }
    return backend
  }

  private addDiscovered(info: PiSessionInfo): void {
    if (this.hiddenIds.has(info.id) || !info.cwd) return
    let workspaceId: string
    try {
      workspaceId = this.workspaces.register(info.cwd).id
    } catch {
      return
    }
    const existing = this.byId.get(info.id)
    if (existing) {
      if (!existing.real) {
        existing.workspaceId = workspaceId
        existing.title = info.name ?? (info.firstMessage.slice(0, 48) || "New chat")
        existing.createdAt = info.createdAt
        existing.updatedAt = info.updatedAt
        existing.sessionFile = info.path
      }
      return
    }
    this.byId.set(info.id, {
      id: info.id,
      workspaceId,
      driverSessionId: info.id,
      title: info.name ?? (info.firstMessage.slice(0, 48) || "New chat"),
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      epoch: randomUUID(),
      sequence: 0,
      projection: createProjectionState(),
      driver: "pi",
      sessionFile: info.path,
    })
  }

  async dispose(): Promise<void> {
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
      Boolean(ui?.isStreaming || session.projection.isStreaming || session.real?.isStreaming())
    const isCompacting = !session.runtimeError && (ui?.isCompacting ?? false)
    let state: SessionSnapshotV1["session"]["state"] = "idle"
    if (session.runtimeError) state = "crashed"
    else if (isCompacting) state = "compacting"
    else if (ui?.retry?.phase === "waiting" || ui?.retry?.phase === "running") state = "retrying"
    else if (isStreaming) state = "running"

    return {
      protocolVersion: 1,
      epoch: session.epoch,
      sequence: session.sequence,
      session: {
        id: session.id,
        workspaceId: session.workspaceId,
        directory: this.workspaces.get(session.workspaceId)?.canonicalRoot ?? "",
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
      timeline: session.projection.timeline as TimelineItemV1[],
      native: {
        namespace: "pi",
        schemaVersion: 1,
        leafId: session.real?.getLeafId() ?? session.nativeLeafId ?? session.projection.timeline.at(-1)?.entryId ?? null,
        entries: session.real?.getEntries() ?? session.nativeEntries ?? [],
        tree: session.real?.getTree() ?? session.nativeTree ?? [],
      },
    }
  }
}

function runtimeReplacedError(): Error {
  return Object.assign(new Error("Pi runtime was replaced before the command completed"), {
    code: "SESSION_RUNTIME_CRASHED",
  })
}

function unsupportedRuntimeOperation(operation: string): Error {
  return Object.assign(new Error(`Pi runtime does not support ${operation}`), { code: "CAPABILITY_DISABLED" })
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
