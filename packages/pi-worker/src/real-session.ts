/**
 * Real Pi AgentSessionRuntime wrapper.
 * Only used when PIUI_DRIVER=pi. Will call configured models.
 */
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type SessionEntry,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent"
import type {
  CompactionCommandResultV1,
  CompactionResultV1,
  CompactionStateV1,
  PiSessionEntryV1,
  PiSessionTreeNodeV1,
  PiToolInfoV1,
  QueueDeliveryModeV1,
  RetryStateV1,
  SessionReplacementResultV1,
} from "@piui/protocol"
import { constants, copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"
import {
  applyWorkerEvent,
  createProjectionState,
  projectEntries,
  type ProjectionDelta,
  type ProjectionState,
} from "./projection.js"
import type { PiContentBlock, PiEntry, WorkerEvent } from "./types.js"
import type { PiModelInfo } from "./worker-protocol.js"

export interface PiRuntimeUiState {
  thinkingLevel: string
  availableThinkingLevels: string[]
  isStreaming: boolean
  isCompacting: boolean
  isIdle: boolean
  queue: {
    steering: string[]
    followUp: string[]
    steeringMode: QueueDeliveryModeV1
    followUpMode: QueueDeliveryModeV1
  }
  retry: RetryStateV1
  compaction: CompactionStateV1
  tools: PiToolInfoV1[]
  activeTools: string[]
  model?: { provider: string; id: string; displayName: string }
  supportsThinking: boolean
}

export interface PiSkillInfo {
  name: string
  description?: string
  source?: string
}

export interface PiCommandInfo {
  name: string
  description?: string
  source: "skill" | "prompt" | "extension" | "builtin"
}

export interface PiSessionInfo {
  id: string
  path: string
  cwd: string
  name?: string
  createdAt: string
  updatedAt: string
  messageCount: number
  firstMessage: string
}

export interface RealPiSessionOpenOptions {
  agentDir?: string
  createRuntime?: CreateAgentSessionRuntimeFactory
  createSessionManager?: (cwd: string, sessionFile?: string) => SessionManager
}

const createDefaultRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({ cwd })
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  }
}

export class RealPiSession {
  private runtime: AgentSessionRuntime
  private projection: ProjectionState = createProjectionState()
  private stateUnsub: (() => void) | null = null
  private lastUserId: string | null = null
  private currentAsstId: string | null = null
  private stateListeners = new Set<(s: PiRuntimeUiState) => void>()
  private projectionListeners = new Set<(projection: ProjectionState) => void>()
  private projectionDeltaListeners = new Set<(projection: ProjectionDelta) => void>()
  /** last known runtime flags from events */
  private isCompactingFlag = false
  private retryState: RetryStateV1 = { phase: "idle", autoEnabled: true }
  private compactionState: CompactionStateV1 = {
    autoEnabled: true,
    operation: { type: "none" },
  }

  private constructor(runtime: AgentSessionRuntime) {
    this.runtime = runtime
    this.bindStateEvents()
  }

  private bindStateEvents(): void {
    this.stateUnsub?.()
    this.stateUnsub = this.runtime.session.subscribe(event => {
      let projectionChanged = false
      for (const workerEvent of mapPiEventToWorker(event, this)) {
        this.projection = applyWorkerEvent(this.projection, workerEvent)
        projectionChanged = true
      }
      if (projectionChanged) {
        this.emitProjection()
        this.emitProjectionDelta()
      }

      if (event.type === "compaction_start") {
        this.isCompactingFlag = true
        this.compactionState = {
          ...this.compactionState,
          operation: { type: "compaction", phase: "running", reason: event.reason },
          lastAborted: undefined,
          lastError: undefined,
          lastNotice: undefined,
        }
      } else if (event.type === "compaction_end") {
        this.isCompactingFlag = false
        this.compactionState = {
          ...this.compactionState,
          operation: { type: "none" },
          lastResult: event.result ? mapCompactionResult(event.result) : this.compactionState.lastResult,
          lastAborted: event.aborted,
          lastError: event.errorMessage,
        }
      } else if (event.type === "auto_retry_start") {
        this.retryState = {
          phase: "waiting",
          autoEnabled: this.runtime.session.autoRetryEnabled,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          nextAttemptAt: new Date(Date.now() + event.delayMs).toISOString(),
          errorMessage: event.errorMessage,
        }
      } else if (event.type === "agent_start" && this.retryState.phase === "waiting") {
        this.retryState = {
          phase: "running",
          autoEnabled: this.runtime.session.autoRetryEnabled,
          attempt: this.retryState.attempt,
          maxAttempts: this.retryState.maxAttempts,
        }
      } else if (event.type === "agent_start" && this.retryState.phase === "finished") {
        this.retryState = { phase: "idle", autoEnabled: this.runtime.session.autoRetryEnabled }
      } else if (event.type === "auto_retry_end") {
        this.retryState = {
          phase: "finished",
          autoEnabled: this.runtime.session.autoRetryEnabled,
          success: event.success,
          attempt: event.attempt,
          finalError: event.finalError,
        }
      } else if (event.type === "summarization_retry_scheduled") {
        const operation = this.compactionState.operation
        if (operation.type !== "none") {
          this.compactionState = {
            ...this.compactionState,
            operation: {
              ...operation,
              phase: "retrying",
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              errorMessage: event.errorMessage,
            },
          }
        }
      } else if (event.type === "summarization_retry_attempt_start") {
        const operation = this.compactionState.operation
        if (operation.type !== "none") {
          this.compactionState = { ...this.compactionState, operation: { ...operation, phase: "running" } }
        }
      }

      if (isRuntimeStateEvent(event.type)) this.emitState()
      if (event.type === "message_end" || event.type === "agent_settled" || event.type === "entry_appended") {
        queueMicrotask(() => {
          const previous = this.projection
          this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
          this.emitProjection()
          this.emitProjectionReconciliation(previous)
          this.emitState()
        })
      }
    })
  }

  private detachSessionSubscriptions(): void {
    this.stateUnsub?.()
    this.stateUnsub = null
  }

  static async open(
    cwd: string,
    sessionFile?: string,
    options: RealPiSessionOpenOptions = {},
  ): Promise<RealPiSession> {
    if (sessionFile && !existsSync(sessionFile)) {
      throw Object.assign(new Error("Pi session file no longer exists"), { code: "SESSION_FILE_NOT_FOUND" })
    }
    const sessionManager = options.createSessionManager?.(cwd, sessionFile) ??
      (sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd))
    if (sessionFile && pathKey(sessionManager.getCwd()) !== pathKey(cwd)) {
      throw Object.assign(new Error("Pi session workspace does not match the selected workspace"), {
        code: "SESSION_WORKSPACE_MISMATCH",
      })
    }
    const projection = sessionFile ? projectNativeBranch(sessionManager.getBranch()) : undefined
    const runtime = await createAgentSessionRuntime(options.createRuntime ?? createDefaultRuntime, {
      cwd: sessionManager.getCwd(),
      agentDir: options.agentDir ?? getAgentDir(),
      sessionManager,
    })

    await runtime.session.bindExtensions({})
    const result = new RealPiSession(runtime)
    runtime.setBeforeSessionInvalidate(() => result.detachSessionSubscriptions())
    runtime.setRebindSession(async session => {
      await session.bindExtensions({})
      result.bindStateEvents()
    })
    if (projection) result.projection = projection
    return result
  }

  static async list(cwd: string): Promise<PiSessionInfo[]> {
    return (await SessionManager.list(cwd)).map(sessionInfo)
  }

  static async listAll(): Promise<PiSessionInfo[]> {
    return (await SessionManager.listAll()).map(sessionInfo)
  }

  static async listModels(): Promise<PiModelInfo[]> {
    const runtime = await ModelRuntime.create({ allowModelNetwork: false })
    return (await runtime.getAvailable()).map(model => {
      const input = (model as { input?: string[] }).input
      return {
        id: model.id,
        name: model.name || model.id,
        providerId: model.provider,
        family: (model as { family?: string }).family || "",
        contextLimit: model.contextWindow ?? 0,
        outputLimit: model.maxTokens ?? 0,
        supportsReasoning: Boolean((model as { reasoning?: boolean }).reasoning),
        supportsImages: Array.isArray(input) && input.includes("image"),
      }
    })
  }

  onState(listener: (s: PiRuntimeUiState) => void): () => void {
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

  private emitState() {
    const s = this.getRuntimeUiState()
    for (const l of this.stateListeners) l(s)
  }

  private emitProjection(): void {
    for (const listener of this.projectionListeners) listener(this.projection)
  }

  private emitProjectionDelta(): void {
    const delta = { ...this.projection, timeline: this.projection.timeline.slice(-1) }
    for (const listener of this.projectionDeltaListeners) listener(delta)
  }

  private emitProjectionReconciliation(previous: ProjectionState): void {
    const nextById = new Map(this.projection.timeline.map(item => [item.id, item]))
    const previousById = new Map(previous.timeline.map(item => [item.id, item]))
    const removedItemIds = previous.timeline
      .filter(item => !nextById.has(item.id))
      .map(item => item.id)
    const changed = this.projection.timeline.filter(item => {
      const old = previousById.get(item.id)
      return !old || JSON.stringify(old) !== JSON.stringify(item)
    }).slice(-2)
    if (removedItemIds.length === 0 && changed.length === 0) return
    const delta: ProjectionDelta = {
      timeline: changed,
      isStreaming: this.projection.isStreaming,
      removedItemIds,
    }
    for (const listener of this.projectionDeltaListeners) listener(delta)
  }

  getProjection(): ProjectionState {
    return this.projection
  }

  getSessionId(): string {
    return this.runtime.session.sessionId
  }

  getSessionFile(): string | undefined {
    return this.runtime.session.sessionFile
  }

  getSessionName(): string | undefined {
    return this.runtime.session.sessionManager.getSessionName()
  }

  getEntries(): PiSessionEntryV1[] {
    return this.runtime.session.sessionManager.getEntries().map(mapSessionEntry)
  }

  getTree(): PiSessionTreeNodeV1[] {
    return mapSessionTree(this.runtime.session.sessionManager.getTree())
  }

  getLeafId(): string | null {
    return this.runtime.session.sessionManager.getLeafId()
  }

  getModel() {
    const m = this.runtime.session.model
    if (!m) return undefined
    return { provider: m.provider, id: m.id, displayName: m.name ?? m.id }
  }

  getThinkingLevel(): string {
    return String(this.runtime.session.thinkingLevel ?? "off")
  }

  getAvailableThinkingLevels(): string[] {
    try {
      const levels = this.runtime.session.getAvailableThinkingLevels?.() ?? []
      return levels.map(String)
    } catch {
      return ["off", "minimal", "low", "medium", "high"]
    }
  }

  isStreaming(): boolean {
    return this.runtime.session.isStreaming
  }

  getRuntimeUiState(): PiRuntimeUiState {
    const session = this.runtime.session
    const steering = [...(session.getSteeringMessages?.() ?? [])].map(String)
    const followUp = [...(session.getFollowUpMessages?.() ?? [])].map(String)
    return {
      thinkingLevel: this.getThinkingLevel(),
      availableThinkingLevels: this.getAvailableThinkingLevels(),
      isStreaming: session.isStreaming,
      isCompacting: this.isCompactingFlag || Boolean(session.isCompacting),
      isIdle: Boolean(session.isIdle ?? !session.isStreaming),
      queue: {
        steering,
        followUp,
        steeringMode: session.steeringMode,
        followUpMode: session.followUpMode,
      },
      retry: { ...this.retryState, autoEnabled: session.autoRetryEnabled },
      compaction: { ...this.compactionState, autoEnabled: session.autoCompactionEnabled },
      tools: session.getAllTools().map(tool => ({
        name: tool.name,
        description: tool.description,
        source: toolSource(tool.sourceInfo),
      })),
      activeTools: session.getActiveToolNames?.() ?? [],
      model: this.getModel(),
      supportsThinking: Boolean(session.supportsThinking?.() ?? true),
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const session = this.runtime.session
    const modelRuntime = session.modelRuntime
    const model = modelRuntime?.getModel?.(provider, modelId)
    if (!model) {
      throw new Error(`model not found: ${provider}/${modelId}`)
    }
    await session.setModel(model)
    this.emitState()
  }

  setThinkingLevel(level: string): void {
    this.runtime.session.setThinkingLevel(level as never)
    this.emitState()
  }

  async compact(customInstructions?: string): Promise<CompactionCommandResultV1> {
    try {
      const result = await this.runtime.session.compact(customInstructions)
      this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
      this.emitProjection()
      this.emitState()
      return { status: "completed", result: mapCompactionResult(result) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/nothing to compact/i.test(message)) {
        this.compactionState = { ...this.compactionState, lastNotice: message, lastError: undefined }
        this.emitState()
        return { status: "skipped", reason: "session_too_small", message }
      }
      if (/already compacted/i.test(message)) {
        this.compactionState = { ...this.compactionState, lastNotice: message, lastError: undefined }
        this.emitState()
        return { status: "skipped", reason: "already_compacted", message }
      }
      if (/compaction cancelled/i.test(message)) return { status: "aborted" }
      throw error
    }
  }

  async navigateTree(
    entryId: string,
    options: {
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    } = {},
  ): Promise<{
    editorText?: string
    cancelled: boolean
    aborted?: boolean
    summaryEntry?: PiSessionEntryV1
  }> {
    await this.runtime.session.waitForIdle()
    if (options.summarize) {
      this.isCompactingFlag = true
      this.compactionState = {
        ...this.compactionState,
        operation: { type: "branchSummary", phase: "running", targetEntryId: entryId },
        lastAborted: undefined,
        lastError: undefined,
      }
      this.emitState()
    }
    let result: Awaited<ReturnType<AgentSessionRuntime["session"]["navigateTree"]>>
    try {
      result = await this.runtime.session.navigateTree(entryId, options)
    } finally {
      if (options.summarize) {
        this.isCompactingFlag = false
        this.compactionState = { ...this.compactionState, operation: { type: "none" } }
        this.emitState()
      }
    }
    if (options.summarize) {
      this.compactionState = { ...this.compactionState, lastAborted: Boolean(result.aborted) }
    }
    if (!result.cancelled) {
      this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
      this.emitProjection()
      this.emitState()
    }
    return {
      editorText: result.editorText,
      cancelled: result.cancelled,
      aborted: result.aborted,
      summaryEntry: result.summaryEntry ? mapSessionEntry(result.summaryEntry) : undefined,
    }
  }

  setLabel(entryId: string, label?: string): void {
    this.runtime.session.sessionManager.appendLabelChange(entryId, label)
    this.emitState()
  }

  setSessionName(name: string): void {
    this.runtime.session.setSessionName(name)
    this.emitState()
  }

  async fork(entryId: string, position: "before" | "at"): Promise<SessionReplacementResultV1> {
    await this.runtime.session.waitForIdle()
    const sourceSessionId = this.getSessionId()
    const result = await this.runtime.fork(entryId, { position })
    if (!result.cancelled) this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
    this.emitState()
    return {
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: this.getSessionFile(),
      targetCwd: this.runtime.cwd,
      selectedText: result.selectedText,
      cancelled: result.cancelled,
    }
  }

  async clone(entryId = this.getLeafId() ?? ""): Promise<SessionReplacementResultV1> {
    if (!entryId) throw Object.assign(new Error("Pi session has no entry to clone"), { code: "INVALID_REQUEST" })
    return this.fork(entryId, "at")
  }

  async importSession(inputPath: string, cwdOverride?: string): Promise<SessionReplacementResultV1> {
    await this.runtime.session.waitForIdle()
    const sourceSessionId = this.getSessionId()
    const sourcePath = resolveUserPath(inputPath)
    if (!existsSync(sourcePath)) {
      const error = new Error(`Import file not found: ${sourcePath}`)
      error.name = "SessionImportFileNotFoundError"
      throw error
    }

    const sessionDir = this.runtime.session.sessionManager.getSessionDir()
    mkdirSync(sessionDir, { recursive: true })
    const stagedPath = path.join(sessionDir, `piui-import-${randomUUID()}.jsonl`)
    copyFileSync(sourcePath, stagedPath, constants.COPYFILE_EXCL)
    let keepStagedFile = false
    try {
      const result = await this.runtime.importFromJsonl(stagedPath, cwdOverride)
      keepStagedFile = !result.cancelled
      if (!result.cancelled) this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
      this.emitState()
      return {
        sourceSessionId,
        targetSessionId: this.getSessionId(),
        targetSessionFile: this.getSessionFile(),
        targetCwd: this.runtime.cwd,
        cancelled: result.cancelled,
      }
    } finally {
      if (!keepStagedFile) {
        try {
          unlinkSync(stagedPath)
        } catch {
          /* best effort cleanup for a cancelled or failed import */
        }
      }
    }
  }

  abortCompaction(): void {
    this.runtime.session.abortCompaction?.()
    this.emitState()
  }

  abortBranchSummary(): void {
    this.runtime.session.abortBranchSummary()
    this.emitState()
  }

  abortRetry(): void {
    this.runtime.session.abortRetry()
    this.emitState()
  }

  setAutoCompaction(enabled: boolean): void {
    this.runtime.session.setAutoCompactionEnabled(enabled)
    this.emitState()
  }

  setAutoRetry(enabled: boolean): void {
    this.runtime.session.setAutoRetryEnabled(enabled)
    this.emitState()
  }

  setQueueModes(modes: {
    steeringMode?: QueueDeliveryModeV1
    followUpMode?: QueueDeliveryModeV1
  }): void {
    if (modes.steeringMode) this.runtime.session.setSteeringMode(modes.steeringMode)
    if (modes.followUpMode) this.runtime.session.setFollowUpMode(modes.followUpMode)
    this.emitState()
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const cleared = this.runtime.session.clearQueue()
    this.emitState()
    return cleared
  }

  setActiveTools(toolNames: string[]): void {
    const available = new Set(this.runtime.session.getAllTools().map(tool => tool.name))
    const normalized = [...new Set(toolNames)]
    const unknown = normalized.filter(name => !available.has(name))
    if (unknown.length > 0) {
      throw Object.assign(new Error(`Unknown Pi tools: ${unknown.join(", ")}`), { code: "INVALID_REQUEST" })
    }
    this.runtime.session.setActiveToolsByName(normalized)
    this.emitState()
  }

  async steer(text: string): Promise<void> {
    if (!this.runtime.session.isStreaming) {
      throw Object.assign(new Error("Cannot steer an idle Pi session"), { code: "SESSION_NOT_RUNNING" })
    }
    await this.runtime.session.steer(text)
    this.emitState()
  }

  async followUp(text: string): Promise<void> {
    if (!this.runtime.session.isStreaming) {
      throw Object.assign(new Error("Cannot queue a follow-up on an idle Pi session"), { code: "SESSION_NOT_RUNNING" })
    }
    await this.runtime.session.followUp(text)
    this.emitState()
  }

  async prompt(text: string): Promise<void> {
    try {
      await this.runtime.session.prompt(text)
    } finally {
      this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
      this.emitProjection()
      this.emitState()
    }
  }

  async abort(): Promise<{ steering: string[]; followUp: string[] }> {
    const cleared = this.runtime.session.clearQueue()
    await this.runtime.session.abort()
    this.emitState()
    return cleared
  }

  listSkills(): PiSkillInfo[] {
    try {
      const loader = this.runtime.session.resourceLoader as unknown as {
        skills?: Array<{ name: string; description?: string; source?: string }>
        getSkills?: () =>
          | Array<{ name: string; description?: string }>
          | { skills: Array<{ name: string; description?: string; source?: string }> }
      }
      const raw = loader.getSkills?.() ?? loader.skills ?? []
      const skills = Array.isArray(raw) ? raw : (raw.skills ?? [])
      return skills.map(s => ({
        name: s.name,
        description: s.description,
        source: (s as { source?: string }).source,
      }))
    } catch {
      return []
    }
  }

  listCommands(): PiCommandInfo[] {
    const out: PiCommandInfo[] = [
      { name: "compact", description: "Compact session context", source: "builtin" },
      { name: "new", description: "New session", source: "builtin" },
    ]
    for (const s of this.listSkills()) {
      out.push({
        name: `skill:${s.name}`,
        description: s.description ?? `Skill ${s.name}`,
        source: "skill",
      })
    }
    try {
      const loader = this.runtime.session.resourceLoader as unknown as {
        promptTemplates?: Array<{ name: string; description?: string }>
        getPromptTemplates?: () => Array<{ name: string; description?: string }>
      }
      const templates = loader.getPromptTemplates?.() ?? loader.promptTemplates ?? []
      for (const t of templates) {
        out.push({
          name: t.name,
          description: t.description ?? `Prompt ${t.name}`,
          source: "prompt",
        })
      }
    } catch {
      /* */
    }
    return out
  }

  async dispose(): Promise<void> {
    this.detachSessionSubscriptions()
    this.stateListeners.clear()
    this.projectionListeners.clear()
    this.projectionDeltaListeners.clear()
    await this.runtime.dispose()
  }

  _setLastUser(id: string) {
    this.lastUserId = id
  }
  _getLastUser() {
    return this.lastUserId
  }
  _setAsst(id: string | null) {
    this.currentAsstId = id
  }
  _getAsst() {
    return this.currentAsstId
  }
}

function mapSessionEntry(entry: SessionEntry): PiSessionEntryV1 {
  const base = { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp }
  switch (entry.type) {
    case "message": {
      const message = entry.message as unknown as Record<string, unknown>
      return {
        ...base,
        type: "message",
        role: messageRole(message.role),
        preview: previewText(extractText(message.content ?? message.result ?? message.summary)),
      }
    }
    case "thinking_level_change":
      return { ...base, type: entry.type, thinkingLevel: entry.thinkingLevel }
    case "model_change":
      return { ...base, type: entry.type, provider: entry.provider, modelId: entry.modelId }
    case "compaction":
      return {
        ...base,
        type: entry.type,
        summary: entry.summary,
        firstKeptEntryId: entry.firstKeptEntryId,
        tokensBefore: entry.tokensBefore,
      }
    case "branch_summary":
      return { ...base, type: entry.type, fromId: entry.fromId, summary: entry.summary }
    case "custom":
      return { ...base, type: entry.type, customType: entry.customType }
    case "custom_message":
      return {
        ...base,
        type: entry.type,
        customType: entry.customType,
        preview: previewText(extractText(entry.content)),
        display: entry.display,
      }
    case "label":
      return { ...base, type: entry.type, targetId: entry.targetId, label: entry.label }
    case "session_info":
      return { ...base, type: entry.type, name: entry.name }
  }
}

function mapSessionTree(nodes: SessionTreeNode[]): PiSessionTreeNodeV1[] {
  const roots: PiSessionTreeNodeV1[] = nodes.map(node => ({
    entry: mapSessionEntry(node.entry),
    children: [] as PiSessionTreeNodeV1[],
    label: node.label,
    labelTimestamp: node.labelTimestamp,
  }))
  const stack = nodes.map((source, index) => ({ source, target: roots[index] }))
  while (stack.length > 0) {
    const current = stack.pop()!
    current.target.children = current.source.children.map(child => ({
      entry: mapSessionEntry(child.entry),
      children: [],
      label: child.label,
      labelTimestamp: child.labelTimestamp,
    }))
    current.source.children.forEach((child, index) => {
      stack.push({ source: child, target: current.target.children[index] })
    })
  }
  return roots
}

function messageRole(value: unknown): Extract<PiSessionEntryV1, { type: "message" }>["role"] {
  if (
    value === "user" || value === "assistant" || value === "toolResult" || value === "bashExecution" ||
    value === "branchSummary" || value === "compactionSummary" || value === "custom"
  ) return value
  return "custom"
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized
}

function resolveUserPath(input: string): string {
  const trimmed = input.trim()
  if (/^file:\/\//i.test(trimmed)) return path.resolve(fileURLToPath(trimmed))
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/") || (process.platform === "win32" && trimmed.startsWith("~\\"))) {
    return path.resolve(homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

function sessionInfo(info: {
  id: string
  path: string
  cwd: string
  name?: string
  created: Date
  modified: Date
  messageCount: number
  firstMessage: string
}): PiSessionInfo {
  return {
    id: info.id,
    path: info.path,
    cwd: info.cwd,
    name: info.name,
    createdAt: info.created.toISOString(),
    updatedAt: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage,
  }
}

function pathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function mapCompactionResult(result: {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  estimatedTokensAfter?: number
}): CompactionResultV1 {
  return {
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: result.tokensBefore,
    estimatedTokensAfter: result.estimatedTokensAfter,
  }
}

function isRuntimeStateEvent(type: string): boolean {
  return type === "agent_start" ||
    type === "agent_end" ||
    type === "agent_settled" ||
    type === "queue_update" ||
    type === "thinking_level_changed" ||
    type === "session_info_changed" ||
    type === "compaction_start" ||
    type === "compaction_end" ||
    type === "auto_retry_start" ||
    type === "auto_retry_end" ||
    type === "summarization_retry_scheduled" ||
    type === "summarization_retry_attempt_start" ||
    type === "summarization_retry_finished"
}

function toolSource(sourceInfo: unknown): string | undefined {
  if (typeof sourceInfo === "string") return sourceInfo
  if (!sourceInfo || typeof sourceInfo !== "object") return undefined
  const source = sourceInfo as Record<string, unknown>
  if (typeof source.type === "string") return source.type
  if (typeof source.path === "string") return source.path
  return undefined
}

function projectNativeBranch(entries: SessionEntry[]): ProjectionState {
  const projected: PiEntry[] = []
  for (const entry of entries) {
    if (entry.type !== "message") continue
    const message = entry.message as unknown as Record<string, unknown>
    const role = message.role
    const messageTimestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp)
    const timestamp = Number.isFinite(messageTimestamp) ? messageTimestamp : 0
    if (role === "user") {
      projected.push({
        type: "message",
        id: entry.id,
        parentId: entry.parentId,
        timestamp,
        message: { role: "user", content: extractText(message.content) },
      })
    } else if (role === "assistant") {
      projected.push({
        type: "message",
        id: entry.id,
        parentId: entry.parentId,
        timestamp,
        message: {
          role: "assistant",
          content: toContentBlocks(message.content),
          provider: typeof message.provider === "string" ? message.provider : undefined,
          model: typeof message.model === "string" ? message.model : undefined,
          stopReason: isStopReason(message.stopReason) ? message.stopReason : undefined,
          errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
        },
      })
    } else if (role === "toolResult") {
      projected.push({
        type: "message",
        id: entry.id,
        parentId: entry.parentId,
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: String(message.toolCallId ?? ""),
          toolName: typeof message.toolName === "string" ? message.toolName : undefined,
          isError: Boolean(message.isError),
          result: extractText(message.content),
        },
      })
    }
  }
  return projectEntries(projected)
}

function isStopReason(value: unknown): value is "stop" | "length" | "toolUse" | "error" | "aborted" {
  return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted"
}

function mapPiEventToWorker(event: { type: string; [k: string]: unknown }, ctx: RealPiSession): WorkerEvent[] {
  const out: WorkerEvent[] = []
  const now = Date.now()

  if (event.type === "message_start") {
    const message = event.message as { role?: string; content?: unknown } | undefined
    const role = message?.role
    if (role === "user") {
      const id = `u-${now}-${Math.random().toString(36).slice(2, 7)}`
      ctx._setLastUser(id)
      out.push({ type: "message_start", entryId: id, role: "user", timestamp: now })
      const text = extractText(message?.content)
      out.push({
        type: "message_end",
        entryId: id,
        role: "user",
        parentId: null,
        timestamp: now,
        message: { role: "user", content: text },
      })
    } else if (role === "assistant") {
      const id = `a-${now}-${Math.random().toString(36).slice(2, 7)}`
      ctx._setAsst(id)
      out.push({ type: "message_start", entryId: id, role: "assistant", timestamp: now })
    }
    return out
  }

  if (event.type === "message_update") {
    const asstId = ctx._getAsst()
    if (!asstId) return out
    const message = event.message as { content?: unknown } | undefined
    // prefer delta path: full content rebuild from message
    const blocks = toContentBlocks(message?.content)
    out.push({ type: "message_update", entryId: asstId, content: blocks })
    return out
  }

  if (event.type === "message_end") {
    const message = event.message as { role?: string; content?: unknown } | undefined
    if (message?.role === "assistant") {
      const asstId = ctx._getAsst() ?? `a-${now}`
      const blocks = toContentBlocks(message.content)
      out.push({
        type: "message_end",
        entryId: asstId,
        role: "assistant",
        parentId: ctx._getLastUser(),
        timestamp: now,
        message: { role: "assistant", content: blocks },
      })
      ctx._setAsst(null)
    } else if (message?.role === "toolResult") {
      const m = message as {
        toolCallId?: string
        isError?: boolean
        content?: unknown
        result?: unknown
      }
      const toolCallId = m.toolCallId ?? ""
      const resultText = extractText(m.content ?? m.result)
      out.push({
        type: "tool_execution_end",
        toolCallId,
        isError: m.isError,
        result: resultText,
      })
      out.push({
        type: "message_end",
        entryId: `tr-${now}`,
        role: "toolResult",
        parentId: ctx._getAsst(),
        timestamp: now,
        message: {
          role: "toolResult",
          toolCallId,
          isError: m.isError,
          result: resultText,
        },
      })
    }
    return out
  }

  if (event.type === "tool_execution_start") {
    out.push({
      type: "tool_execution_start",
      toolCallId: String(event.toolCallId ?? ""),
      toolName: String(event.toolName ?? "tool"),
      args: event.args,
    })
    return out
  }

  if (event.type === "tool_execution_end") {
    out.push({
      type: "tool_execution_end",
      toolCallId: String(event.toolCallId ?? ""),
      isError: Boolean(event.isError),
      result: extractText(event.result),
    })
    return out
  }

  if (event.type === "agent_end" || event.type === "agent_settled") {
    out.push({ type: "agent_end" })
  }

  return out
}

function extractText(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map(b => {
        if (!b || typeof b !== "object") return ""
        const o = b as Record<string, unknown>
        if (o.type === "text" && typeof o.text === "string") return o.text
        if (typeof o.text === "string") return o.text
        return ""
      })
      .join("")
  }
  return String(content)
}

function toContentBlocks(content: unknown): PiContentBlock[] {
  if (content == null) return []
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }]
  const blocks: PiContentBlock[] = []
  for (const b of content) {
    if (!b || typeof b !== "object") continue
    const o = b as Record<string, unknown>
    if (o.type === "text" && typeof o.text === "string") {
      blocks.push({ type: "text", text: o.text })
    } else if (o.type === "thinking" || o.type === "reasoning") {
      const t = typeof o.thinking === "string" ? o.thinking : typeof o.text === "string" ? o.text : ""
      blocks.push({ type: "thinking", thinking: t })
    } else if (o.type === "toolCall" || o.type === "tool_use") {
      blocks.push({
        type: "toolCall",
        id: String(o.id ?? o.toolCallId ?? `tc-${Date.now()}`),
        name: String(o.name ?? o.toolName ?? "tool"),
        arguments: o.arguments ?? o.input ?? {},
      })
    }
  }
  return blocks
}
