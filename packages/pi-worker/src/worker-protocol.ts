import type {
  CompactionCommandResultV1,
  ExtensionUiDialogResponseV1,
  PiSettingsPatchV1,
  PiSettingsSnapshotV1,
  ProjectTrustV1,
  ProviderAuthEventV1,
  ProviderAuthInfoV1,
  ConfiguredPackageV1,
  CustomMessageContentV1,
  PackageProgressV1,
  PiNavigationResultV1,
  PiResourceSnapshotV1,
  PiResourceExtensionPathsV1,
  PiRuntimeInspectionV1,
  ResolvedPackageResourcesV1,
  PackageUpdateV1,
  PiModelRuntimeSnapshotV1,
  PiNativeModelV1,
  PiNativeJsonValueV1,
  PiNativeSessionHeadV1,
  PiNativeEntriesPageV1,
  QueueDeliveryModeV1,
  SessionReplacementResultV1,
} from "@piui/protocol"
import type { PiExtensionUiEvent } from "./extension-ui-bridge.js"
import type { PiCommandInfo, PiRuntimeUiState, PiSessionInfo, PiSkillInfo } from "./real-session.js"

export interface WorkerSessionWire {
  sessionId: string
  sessionFile?: string
  sessionName?: string
  state: PiRuntimeUiState
  native: PiNativeSessionHeadV1
}

export type PiModelInfo = PiNativeModelV1

export interface PiImageInput {
  type: "image"
  data: string
  mimeType: string
}

export interface PiBashResult {
  output: string
  exitCode?: number
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
}

export const PI_WORKER_PROTOCOL_VERSION = 13 as const
export const PI_WORKER_HEARTBEAT_INTERVAL_MS = 5_000

export type PiWorkerCapability =
  | "catalog.sessions"
  | "catalog.models"
  | "runtime.open"
  | "runtime.prompt"
  | "runtime.control"
  | "runtime.abort"
  | "runtime.model"
  | "runtime.thinking"
  | "runtime.compact"
  | "runtime.retry"
  | "runtime.tools"
  | "runtime.tree"
  | "runtime.fork"
  | "runtime.import"
  | "runtime.skills"
  | "runtime.commands"
  | "runtime.bash"
  | "runtime.export"
  | "runtime.reload"
  | "runtime.extensionUi"
  | "management.settings"
  | "management.trust"
  | "management.auth"
  | "management.packages"

export interface WorkerHello {
  kind: "hello"
  workerProtocolVersion: number
  piSdkVersion: string
  generation: string
  processId: number
  heartbeatIntervalMs: number
  capabilities: PiWorkerCapability[]
}

export type WorkerCommand =
  | { type: "list"; cwd: string }
  | { type: "listAll" }
  | { type: "listModels" }
  | { type: "open"; cwd: string; sessionFile?: string }
  | { type: "prompt"; text: string; images?: PiImageInput[]; expandPromptTemplates?: boolean }
  | { type: "steer"; text: string; images?: PiImageInput[] }
  | { type: "followUp"; text: string; images?: PiImageInput[] }
  | { type: "abort" }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinkingLevel"; level: string }
  | { type: "cycleThinkingLevel" }
  | { type: "sendUserMessage"; text: string; images?: PiImageInput[]; deliverAs?: "steer" | "followUp" }
  | { type: "compact"; instructions?: string }
  | { type: "abortCompaction" }
  | { type: "abortBranchSummary" }
  | { type: "abortRetry" }
  | { type: "setAutoCompaction"; enabled: boolean }
  | { type: "setAutoRetry"; enabled: boolean }
  | {
      type: "setQueueModes"
      steeringMode?: QueueDeliveryModeV1
      followUpMode?: QueueDeliveryModeV1
    }
  | { type: "clearQueue" }
  | { type: "setActiveTools"; toolNames: string[] }
  | { type: "cycleModel"; direction?: "forward" | "backward" }
  | { type: "setScopedModels"; patterns: string[] }
  | { type: "listRuntimeModels" }
  | {
      type: "sendCustomMessage"
      customType: string
      content: CustomMessageContentV1[]
      display: boolean
      details?: unknown
      triggerTurn?: boolean
      deliverAs?: "steer" | "followUp" | "nextTurn"
    }
  | { type: "appendCustomEntry"; customType: string; data?: unknown }
  | { type: "waitForIdle" }
  | { type: "inspectToolDefinition"; toolName: string }
  | { type: "hasExtensionHandlers"; eventType: string }
  | { type: "inspectSystemPrompt" }
  | { type: "inspectRuntime" }
  | { type: "getNativeEntriesPage"; cursor?: string; limit: number; maxBytes: number }
  | { type: "getNativeBranchPage"; cursor?: string; limit: number; maxBytes: number }
  | { type: "getNativeTree" }
  | { type: "getNativeImageAttachment"; entryId: string; blockIndex: number }
  | { type: "inspectResources" }
  | { type: "extendResources"; paths: PiResourceExtensionPathsV1 }
  | { type: "executeBash"; command: string; excludeFromContext?: boolean }
  | { type: "abortBash" }
  | { type: "exportHtml"; outputPath: string }
  | { type: "exportJsonl"; outputPath: string }
  | { type: "reload" }
  | { type: "initializeExtensions" }
  | { type: "respondExtensionUi"; requestId: string; response: ExtensionUiDialogResponseV1 }
  | { type: "setExtensionEditorState"; text: string }
  | { type: "getSettings"; cwd: string }
  | { type: "patchSettings"; cwd: string; patch: PiSettingsPatchV1 }
  | { type: "getProjectTrust"; cwd: string }
  | { type: "setProjectTrust"; cwd: string; decision: boolean | null }
  | { type: "listProviders" }
  | { type: "startProviderAuth"; providerId: string; authType: "api_key" | "oauth" }
  | { type: "respondProviderAuth"; flowId: string; promptId: string; value: string }
  | { type: "cancelProviderAuth"; flowId: string }
  | { type: "logoutProvider"; providerId: string }
  | { type: "inspectModelRuntime" }
  | { type: "setRuntimeApiKey"; providerId: string; apiKey: string }
  | { type: "removeRuntimeApiKey"; providerId: string }
  | { type: "reloadModelRuntime" }
  | { type: "refreshModelRuntime"; options?: Record<string, unknown> }
  | { type: "listPackages"; cwd: string }
  | {
      type: "managePackage"
      cwd: string
      commandId: string
      action: "install" | "remove" | "update"
      source?: string
      local?: boolean
      persist?: boolean
    }
  | { type: "resolvePackages"; cwd: string; missingAction?: "install" | "skip" | "error" }
  | { type: "resolveExtensionSources"; cwd: string; sources: string[]; local?: boolean; temporary?: boolean }
  | { type: "changePackageSource"; cwd: string; source: string; operation: "add" | "remove"; local?: boolean }
  | { type: "getInstalledPackagePath"; cwd: string; source: string; scope: "user" | "project" }
  | { type: "checkPackageUpdates"; cwd: string }
  | {
      type: "navigateTree"
      entryId: string
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    }
  | { type: "setLabel"; entryId: string; label?: string }
  | { type: "setSessionName"; name: string }
  | { type: "fork"; entryId: string; position: "before" | "at" }
  | { type: "clone"; entryId?: string }
  | { type: "newSession"; parentSession?: string }
  | { type: "switchSession"; sessionPath: string; cwdOverride?: string }
  | { type: "importSession"; inputPath: string; cwdOverride?: string }
  | { type: "listSkills" }
  | { type: "listCommands" }
  | { type: "dispose" }

export interface WorkerRequest {
  kind: "request"
  id: string
  generation: string
  sessionId?: string
  command: WorkerCommand
}

export type WorkerResult =
  | { type: "sessions"; sessions: PiSessionInfo[] }
  | { type: "models"; models: PiModelInfo[] }
  | { type: "session"; session: WorkerSessionWire }
  | { type: "skills"; skills: PiSkillInfo[] }
  | { type: "commands"; commands: PiCommandInfo[] }
  | { type: "bash"; result: PiBashResult; session: WorkerSessionWire }
  | { type: "export"; format: "html" | "jsonl"; path: string }
  | { type: "scopedModels"; diagnostics: Array<{ message: string; pattern: string }>; session: WorkerSessionWire }
  | { type: "settings"; settings: PiSettingsSnapshotV1 }
  | { type: "trust"; trust: ProjectTrustV1 }
  | { type: "providers"; providers: ProviderAuthInfoV1[] }
  | { type: "authFlow"; flowId: string }
  | { type: "modelRuntime"; runtime: PiModelRuntimeSnapshotV1 }
  | { type: "modelRefresh"; result: unknown }
  | { type: "packages"; packages: ConfiguredPackageV1[] }
  | { type: "packageResources"; resources: ResolvedPackageResourcesV1 }
  | { type: "packageSource"; changed: boolean; packages: ConfiguredPackageV1[] }
  | { type: "packagePath"; path?: string }
  | { type: "packageUpdates"; updates: PackageUpdateV1[] }
  | { type: "text"; text: string }
  | { type: "data"; data?: unknown }
  | { type: "boolean"; value: boolean }
  | { type: "runtimeInspection"; inspection: PiRuntimeInspectionV1 }
  | { type: "nativeEntriesPage"; page: PiNativeEntriesPageV1 }
  | { type: "nativeBranchPage"; page: PiNativeEntriesPageV1 }
  | { type: "nativeTree"; tree: Array<{ [key: string]: PiNativeJsonValueV1 }> }
  | { type: "nativeImageAttachment"; mimeType: string; data: string; etag: string }
  | { type: "resources"; resources: PiResourceSnapshotV1 }
  | ({ type: "navigation"; session: WorkerSessionWire } & PiNavigationResultV1)
  | { type: "compaction"; compaction: CompactionCommandResultV1; session: WorkerSessionWire }
  | { type: "queue"; steering: string[]; followUp: string[]; session: WorkerSessionWire }
  | { type: "thinkingLevel"; level: string; session: WorkerSessionWire }
  | { type: "replacement"; replacement: SessionReplacementResultV1; session: WorkerSessionWire }
  | { type: "ok" }

export type WorkerResponse =
  | { kind: "response"; id: string; generation: string; ok: true; result: WorkerResult }
  | { kind: "response"; id: string; generation: string; ok: false; error: { code: string; message: string } }

export type WorkerHostCall =
  | {
      type: "extensionReplacement.reserve"
      reservationId: string
      sourceSessionId: string
      operation: "new" | "fork" | "clone" | "switch" | "import"
      targetSessionFile?: string
    }
  | {
      type: "extensionReplacement.commit"
      reservationId: string
      replacement: SessionReplacementResultV1
      session: WorkerSessionWire
    }
  | { type: "extensionReplacement.abort"; reservationId: string }
  | { type: "extensionShutdown"; sessionId: string }

export interface WorkerHostCallMessage {
  kind: "hostCall"
  id: string
  generation: string
  call: WorkerHostCall
}

export type WorkerHostReply =
  | { kind: "hostReply"; id: string; generation: string; ok: true }
  | { kind: "hostReply"; id: string; generation: string; ok: false; error: { code: string; message: string } }

export type WorkerIpcEvent =
  | { kind: "event"; generation: string; type: "state"; state: PiRuntimeUiState }
  | { kind: "event"; generation: string; type: "nativeEvent"; event: PiNativeJsonValueV1 }
  | { kind: "event"; generation: string; type: "nativeHead"; native: PiNativeSessionHeadV1 }
  | { kind: "event"; generation: string; type: "resourcesChanged" }
  | { kind: "event"; generation: string; type: "extensionUi"; event: PiExtensionUiEvent }
  | { kind: "event"; generation: string; type: "providerAuth"; event: ProviderAuthEventV1 }
  | { kind: "event"; generation: string; type: "packageProgress"; event: PackageProgressV1 }

export interface WorkerHeartbeat {
  kind: "heartbeat"
  generation: string
  timestamp: number
}

export type WorkerMessage = WorkerHello | WorkerResponse | WorkerIpcEvent | WorkerHeartbeat | WorkerHostCallMessage
export type WorkerParentMessage = WorkerRequest | WorkerHostReply
