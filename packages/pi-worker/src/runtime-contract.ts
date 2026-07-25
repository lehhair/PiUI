import type { ProjectionState } from "./projection.js"
import type { PiCommandInfo, PiRuntimeUiState, PiSkillInfo } from "./real-session.js"

export interface PiSessionRuntime {
  onState(listener: (state: PiRuntimeUiState) => void): () => void
  getProjection(): ProjectionState
  getSessionId(): string
  getSessionFile(): string | undefined
  getSessionName(): string | undefined
  getEntries(): unknown[]
  getTree(): unknown[]
  getLeafId(): string | null
  getModel(): { provider: string; id: string; displayName: string } | undefined
  getThinkingLevel(): string
  getAvailableThinkingLevels(): string[]
  isStreaming(): boolean
  getRuntimeUiState(): PiRuntimeUiState
  setModel(provider: string, modelId: string): Promise<void>
  setThinkingLevel(level: string): void | Promise<void>
  compact(customInstructions?: string): Promise<void>
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
