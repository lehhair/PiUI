import type { ProjectionState } from "./projection.js"
import type { PiCommandInfo, PiRuntimeUiState, PiSkillInfo } from "./real-session.js"
import type { PiSessionEntryV1, PiSessionTreeNodeV1, SessionReplacementResultV1 } from "@piui/protocol"

export interface PiSessionRuntime {
  getWorkerGeneration?(): string | undefined
  onCrash?(listener: (error: Error) => void): () => void
  onState(listener: (state: PiRuntimeUiState) => void): () => void
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
  compact(customInstructions?: string): Promise<void>
  navigateTree(entryId: string, summarize?: boolean): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean }>
  setLabel(entryId: string, label?: string): void | Promise<void>
  setSessionName(name: string): void | Promise<void>
  fork(entryId: string, position: "before" | "at"): Promise<SessionReplacementResultV1>
  clone(entryId?: string): Promise<SessionReplacementResultV1>
  importSession(inputPath: string, cwdOverride?: string): Promise<SessionReplacementResultV1>
  prompt(
    text: string,
    onTick?: (projection: ProjectionState) => void,
    opts?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void>
  abort(): Promise<void>
  listSkills(): PiSkillInfo[] | Promise<PiSkillInfo[]>
  listCommands(): PiCommandInfo[] | Promise<PiCommandInfo[]>
  dispose(): Promise<void>
}
