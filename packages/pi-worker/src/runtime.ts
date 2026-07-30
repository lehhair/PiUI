import type { ImageInput, JsonObject, JsonValue, RegistrySnapshot, SessionActivityStatus } from "@piui/protocol"

export interface PiEventMeta {
  epoch: string
  sequence: number
  liveMessage?: { id: string; revision: number }
}

export type Unsubscribe = () => void

export interface SessionRuntime {
  getSessionId(): string
  getSessionFile(): string | undefined
  getCwd(): string

  onPiEvent(listener: (event: JsonObject, meta: PiEventMeta) => void): Unsubscribe
  onHead(listener: (head: JsonObject) => void): Unsubscribe
  onActivity?(listener: (status: SessionActivityStatus | null) => void): Unsubscribe
  onExtensionUi?(listener: (event: JsonObject) => void): Unsubscribe
  onResourcesChanged?(listener: () => void): Unsubscribe
  onReplacement?(listener: (replacement: JsonObject) => void | Promise<void>): Unsubscribe
  onCrash?(listener: (error: Error) => void): Unsubscribe
  onClose?(listener: () => void): Unsubscribe

  getState(): JsonObject | Promise<JsonObject>
  getEntriesPage(cursor: string | undefined, limit: number, maxBytes: number): JsonObject | Promise<JsonObject>
  getBranchPage(cursor: string | undefined, limit: number, maxBytes: number): JsonObject | Promise<JsonObject>
  getTree(): JsonValue | Promise<JsonValue>
  getAttachment(entryId: string, blockIndex: number): JsonObject | Promise<JsonObject>
  getRegistry(): RegistrySnapshot | Promise<RegistrySnapshot>

  prompt(text: string, images?: ImageInput[], options?: { expandPromptTemplates?: boolean; streamingBehavior?: "steer" | "followUp" }): Promise<void>
  steer(text: string, images?: ImageInput[]): Promise<void>
  followUp(text: string, images?: ImageInput[]): Promise<void>
  sendUserMessage(text: string, images?: ImageInput[], deliverAs?: "steer" | "followUp"): Promise<void>
  abort(): Promise<JsonValue | undefined>

  newSession(parentSession?: string): Promise<JsonObject>
  switchSession(sessionPath: string, cwdOverride?: string): Promise<JsonObject>
  fork(entryId: string, position: "before" | "at"): Promise<JsonObject>
  clone(entryId?: string): Promise<JsonObject>
  importSession(inputPath: string, cwdOverride?: string): Promise<JsonObject>
  setSessionName(name: string): Promise<void>

  setModel(provider: string, modelId: string): Promise<void>
  cycleModel(direction?: "forward" | "backward"): Promise<void>
  setScopedModels(patterns: string[]): Promise<JsonValue | undefined>
  setThinkingLevel(level: string): Promise<void>
  cycleThinkingLevel(): Promise<JsonValue | undefined>

  setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>
  setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>
  clearQueue(): Promise<JsonValue | undefined>

  compact(customInstructions?: string): Promise<JsonValue | undefined>
  abortCompaction(): Promise<void>
  abortBranchSummary(): Promise<void>
  setAutoCompaction(enabled: boolean): Promise<void>
  setAutoRetry(enabled: boolean): Promise<void>
  abortRetry(): Promise<void>

  bash(command: string, excludeFromContext?: boolean): Promise<JsonValue | undefined>
  abortBash(): Promise<void>

  setActiveTools(toolNames: string[]): Promise<void>
  invokeTool(name: string, args?: JsonObject): Promise<JsonValue | undefined>
  invokeCommand(name: string, args?: string): Promise<JsonValue | undefined>

  navigateTree(
    entryId: string,
    options?: {
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    },
  ): Promise<JsonObject>
  setLabel(entryId: string, label?: string): Promise<void>

  sendCustomMessage(
    customType: string,
    content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
    options: {
      display: boolean
      details?: JsonValue
      triggerTurn?: boolean
      deliverAs?: "steer" | "followUp" | "nextTurn"
    },
  ): Promise<void>
  appendCustomEntry(customType: string, data?: JsonValue): Promise<void>

  exportHtml(outputPath: string): Promise<JsonValue | undefined>
  exportJsonl(outputPath: string): Promise<JsonValue | undefined>

  waitForIdle(): Promise<void>
  reload(): Promise<void>
  respondExtensionUi(requestId: string, response: JsonObject): Promise<boolean>
  setExtensionEditorState(text: string): Promise<void>

  dispose(): Promise<void>
}

export interface CatalogProvider {
  listSessions(cwd: string): Promise<JsonValue>
  listAllSessions(): Promise<JsonValue>
  deleteSession(cwd: string, sessionFile: string): Promise<void>
  listModels(): Promise<JsonValue>
  getSettings(cwd: string): JsonValue | Promise<JsonValue>
  patchSettings(cwd: string, patch: JsonObject): Promise<JsonValue>
  getProjectTrust(cwd: string): JsonValue | Promise<JsonValue>
  setProjectTrust(cwd: string, decision: boolean | null): JsonValue | Promise<JsonValue>
}
