import type { ProjectionDelta, ProjectionState } from "./projection.js"
import type { PiCommandInfo, PiRuntimeUiState, PiSkillInfo } from "./real-session.js"
import type {
  CompactionCommandResultV1,
  PiNavigationResultV1,
  PiSessionEntryV1,
  PiSessionTreeNodeV1,
  QueueDeliveryModeV1,
  SessionReplacementResultV1,
} from "@piui/protocol"

export interface PiSessionRuntime {
  getWorkerGeneration?(): string | undefined
  onCrash?(listener: (error: Error) => void): () => void
  onState(listener: (state: PiRuntimeUiState) => void): () => void
  onProjection(listener: (projection: ProjectionState) => void): () => void
  onProjectionDelta(listener: (projection: ProjectionDelta) => void): () => void
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
  importSession(inputPath: string, cwdOverride?: string): Promise<SessionReplacementResultV1>
  prompt(text: string): Promise<void>
  steer(text: string): Promise<void>
  followUp(text: string): Promise<void>
  abort(): Promise<{ steering: string[]; followUp: string[] }>
  listSkills(): PiSkillInfo[] | Promise<PiSkillInfo[]>
  listCommands(): PiCommandInfo[] | Promise<PiCommandInfo[]>
  dispose(): Promise<void>
}
