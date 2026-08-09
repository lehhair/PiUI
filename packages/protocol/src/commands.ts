import type { JsonObject, JsonValue } from "./json.js"
import type { ExtensionUiDialogResponse } from "./extension-ui.js"

export const CORE_COMMAND_TYPES = [
  "prompt",
  "steer",
  "followUp",
  "sendUserMessage",
  "abort",
  "newSession",
  "switchSession",
  "fork",
  "importSession",
  "setSessionName",
  "setModel",
  "cycleModel",
  "setScopedModels",
  "setThinkingLevel",
  "cycleThinkingLevel",
  "setSteeringMode",
  "setFollowUpMode",
  "clearQueue",
  "compact",
  "abortCompaction",
  "abortBranchSummary",
  "setAutoCompaction",
  "setAutoRetry",
  "abortRetry",
  "bash",
  "abortBash",
  "setActiveTools",
  "invokeTool",
  "invokeCommand",
  "navigateTree",
  "setLabel",
  "sendCustomMessage",
  "appendCustomEntry",
  "exportHtml",
  "exportJsonl",
  "waitForIdle",
  "reload",
  "respondExtensionUi",
  "setExtensionEditorState",
] as const

export type CoreCommandType = (typeof CORE_COMMAND_TYPES)[number]

export type QueueDeliveryMode = "all" | "one-at-a-time"

export type ImageInput = {
  type: "image"
  data: string
  mimeType: string
}

export type CustomMessageContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

export type PromptParams = {
  text: string
  images?: ImageInput[]
  expandPromptTemplates?: boolean
  streamingBehavior?: "steer" | "followUp"
}

export type SteerParams = {
  text: string
  images?: ImageInput[]
}

export type FollowUpParams = {
  text: string
  images?: ImageInput[]
}

export type SendUserMessageParams = {
  text: string
  images?: ImageInput[]
  deliverAs?: "steer" | "followUp"
}

export type NewSessionParams = {
  parentSession?: string
}

export type SwitchSessionParams = {
  sessionPath: string
  cwdOverride?: string
}

export type ForkParams = {
  entryId: string
  /** 缺省 "at"（worker 侧补默认值） */
  position?: "before" | "at"
}

export type ImportSessionParams = {
  inputPath: string
  cwdOverride?: string
}

export type SetSessionNameParams = {
  name: string
}

export type SetModelParams = {
  provider: string
  modelId: string
}

export type CycleModelParams = {
  direction?: "forward" | "backward"
}

export type SetScopedModelsParams = {
  patterns: string[]
}

export type SetThinkingLevelParams = {
  level: string
}

export type SetQueueModeParams = {
  mode: QueueDeliveryMode
}

export type CompactParams = {
  customInstructions?: string
}

export type SetEnabledParams = {
  enabled: boolean
}

export type BashParams = {
  command: string
  excludeFromContext?: boolean
  /** 前端生成的关联键：作为 bash_execution_update 事件的 id 透传 */
  clientId?: string
}

export type SetActiveToolsParams = {
  toolNames: string[]
}

export type InvokeToolParams = {
  name: string
  arguments?: JsonObject
}

export type InvokeCommandParams = {
  name: string
  args?: string
}

export type NavigateTreeParams = {
  entryId: string
  summarize?: boolean
  customInstructions?: string
  replaceInstructions?: boolean
  label?: string
}

export type SetLabelParams = {
  entryId: string
  label?: string
}

export type SendCustomMessageParams = {
  customType: string
  content: CustomMessageContent[]
  display: boolean
  details?: JsonValue
  triggerTurn?: boolean
  deliverAs?: "steer" | "followUp" | "nextTurn"
}

export type AppendCustomEntryParams = {
  customType: string
  data?: JsonValue
}

export type ExportParams = {
  outputPath: string
}

export type RespondExtensionUiParams = {
  requestId: string
  response: ExtensionUiDialogResponse
}

export type SetExtensionEditorStateParams = {
  text: string
}

export type ExtensionTuiInputParams = {
  data: string
}

export type ExtensionTuiResizeParams = {
  cols: number
  rows: number
}

export type CoreCommandParams = {
  prompt: PromptParams
  steer: SteerParams
  followUp: FollowUpParams
  sendUserMessage: SendUserMessageParams
  abort: Record<string, never>
  newSession: NewSessionParams
  switchSession: SwitchSessionParams
  fork: ForkParams
  importSession: ImportSessionParams
  setSessionName: SetSessionNameParams
  setModel: SetModelParams
  cycleModel: CycleModelParams
  setScopedModels: SetScopedModelsParams
  setThinkingLevel: SetThinkingLevelParams
  cycleThinkingLevel: Record<string, never>
  setSteeringMode: SetQueueModeParams
  setFollowUpMode: SetQueueModeParams
  clearQueue: Record<string, never>
  compact: CompactParams
  abortCompaction: Record<string, never>
  abortBranchSummary: Record<string, never>
  setAutoCompaction: SetEnabledParams
  setAutoRetry: SetEnabledParams
  abortRetry: Record<string, never>
  bash: BashParams
  abortBash: Record<string, never>
  setActiveTools: SetActiveToolsParams
  invokeTool: InvokeToolParams
  invokeCommand: InvokeCommandParams
  navigateTree: NavigateTreeParams
  setLabel: SetLabelParams
  sendCustomMessage: SendCustomMessageParams
  appendCustomEntry: AppendCustomEntryParams
  exportHtml: ExportParams
  exportJsonl: ExportParams
  waitForIdle: Record<string, never>
  reload: Record<string, never>
  respondExtensionUi: RespondExtensionUiParams
  setExtensionEditorState: SetExtensionEditorStateParams
  "extensionUi.tuiInput": ExtensionTuiInputParams
  "extensionUi.tuiResize": ExtensionTuiResizeParams
  "extensionUi.tuiRedraw": Record<string, never>
}
