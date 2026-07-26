import type { ProjectionDelta, ProjectionState } from "./projection.js"
import type { PiCommandInfo, PiRuntimeUiState, PiSkillInfo } from "./real-session.js"
import type { PiBashResult, PiImageInput, PiModelInfo } from "./worker-protocol.js"
import type { ExtensionUiDialogResponseV1 } from "@piui/protocol"
import type { CustomMessageContentV1 } from "@piui/protocol"
import type { PiExtensionUiEvent } from "./extension-ui-bridge.js"
import type {
  CompactionCommandResultV1,
  PiNavigationResultV1,
  PiSessionEntryV1,
  PiSessionTreeNodeV1,
  PiResourceSnapshotV1,
  PiResourceExtensionPathsV1,
  PiRuntimeInspectionV1,
  QueueDeliveryModeV1,
  SessionReplacementResultV1,
} from "@piui/protocol"

export interface PiSessionRuntime {
  getWorkerGeneration?(): string | undefined
  onCrash?(listener: (error: Error) => void): () => void
  onState(listener: (state: PiRuntimeUiState) => void): () => void
  onProjection(listener: (projection: ProjectionState) => void): () => void
  onProjectionDelta(listener: (projection: ProjectionDelta) => void): () => void
  onNativeEvent?(listener: (event: unknown) => void): () => void
  onResourcesChanged?(listener: () => void): () => void
  listRuntimeProviders?(): Promise<import("@piui/protocol").ProviderAuthInfoV1[]>
  startRuntimeProviderAuth?(providerId: string, authType: "api_key" | "oauth"): Promise<string>
  respondRuntimeProviderAuth?(flowId: string, promptId: string, value: string): Promise<void>
  cancelRuntimeProviderAuth?(flowId: string): Promise<void>
  logoutRuntimeProvider?(providerId: string): Promise<void>
  onProviderAuth?(listener: (event: import("@piui/protocol").ProviderAuthEventV1) => void): () => void
  inspectSessionModelRuntime?(): Promise<import("@piui/protocol").PiModelRuntimeSnapshotV1>
  setSessionRuntimeApiKey?(providerId: string, apiKey: string): Promise<void>
  removeSessionRuntimeApiKey?(providerId: string): Promise<void>
  reloadSessionModelRuntime?(): Promise<void>
  refreshSessionModelRuntime?(options?: Record<string, unknown>): Promise<unknown>
  getProjection(): ProjectionState
  getSessionId(): string
  getSessionFile(): string | undefined
  getSessionName(): string | undefined
  getEntries(): PiSessionEntryV1[]
  getTree(): PiSessionTreeNodeV1[]
  getLeafId(): string | null
  getModel(): { provider: string; id: string; displayName: string } | undefined
  getThinkingLevel(): string
  getAvailableThinkingLevels(): string[]
  isStreaming(): boolean
  getRuntimeUiState(): PiRuntimeUiState
  setModel(provider: string, modelId: string): Promise<void>
  setThinkingLevel(level: string): void | Promise<void>
  compact(customInstructions?: string): Promise<CompactionCommandResultV1>
  abortCompaction(): void | Promise<void>
  abortBranchSummary(): void | Promise<void>
  abortRetry(): void | Promise<void>
  setAutoCompaction(enabled: boolean): void | Promise<void>
  setAutoRetry(enabled: boolean): void | Promise<void>
  setQueueModes(modes: {
    steeringMode?: QueueDeliveryModeV1
    followUpMode?: QueueDeliveryModeV1
  }): void | Promise<void>
  clearQueue(): { steering: string[]; followUp: string[] } | Promise<{ steering: string[]; followUp: string[] }>
  setActiveTools(toolNames: string[]): void | Promise<void>
  cycleModel(direction?: "forward" | "backward"): Promise<void>
  setScopedModels(patterns: string[]): Promise<Array<{ message: string; pattern: string }>>
  listAvailableModels(): Promise<PiModelInfo[]>
  sendCustomMessage(
    customType: string,
    content: CustomMessageContentV1[],
    options: {
      display: boolean
      details?: unknown
      triggerTurn?: boolean
      deliverAs?: "steer" | "followUp" | "nextTurn"
    },
  ): Promise<void>
  appendCustomEntry(customType: string, data?: unknown): void | Promise<void>
  waitForIdle(): Promise<void>
  getToolDefinition(toolName: string): unknown | Promise<unknown>
  hasExtensionHandlers(eventType: string): boolean | Promise<boolean>
  getSystemPrompt(): string | Promise<string>
  inspectRuntime(): PiRuntimeInspectionV1 | Promise<PiRuntimeInspectionV1>
  inspectResources(): PiResourceSnapshotV1 | Promise<PiResourceSnapshotV1>
  extendResources(paths: PiResourceExtensionPathsV1): void | Promise<void>
  executeBash(command: string, excludeFromContext?: boolean): Promise<PiBashResult>
  abortBash(): void | Promise<void>
  exportHtml(outputPath: string): Promise<string>
  exportJsonl(outputPath: string): string | Promise<string>
  reload(): Promise<void>
  initializeExtensions?(): Promise<void>
  onExtensionUi?(listener: (event: PiExtensionUiEvent) => void): () => void
  respondExtensionUi?(requestId: string, response: ExtensionUiDialogResponseV1): boolean | Promise<boolean>
  setExtensionEditorState?(text: string): void | Promise<void>
  navigateTree(
    entryId: string,
    options?: {
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    },
  ): Promise<PiNavigationResultV1>
  setLabel(entryId: string, label?: string): void | Promise<void>
  setSessionName(name: string): void | Promise<void>
  fork(entryId: string, position: "before" | "at"): Promise<SessionReplacementResultV1>
  clone(entryId?: string): Promise<SessionReplacementResultV1>
  newSession(parentSession?: string): Promise<SessionReplacementResultV1>
  switchSession(sessionPath: string, cwdOverride?: string): Promise<SessionReplacementResultV1>
  importSession(inputPath: string, cwdOverride?: string): Promise<SessionReplacementResultV1>
  prompt(text: string, images?: PiImageInput[]): Promise<void>
  steer(text: string, images?: PiImageInput[]): Promise<void>
  followUp(text: string, images?: PiImageInput[]): Promise<void>
  abort(): Promise<{ steering: string[]; followUp: string[] }>
  listSkills(): PiSkillInfo[] | Promise<PiSkillInfo[]>
  listCommands(): PiCommandInfo[] | Promise<PiCommandInfo[]>
  dispose(): Promise<void>
}
