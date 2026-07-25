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
} from "@earendil-works/pi-coding-agent"
import { existsSync } from "node:fs"
import path from "node:path"
import {
  applyWorkerEvent,
  createProjectionState,
  projectEntries,
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
  queue: { steering: string[]; followUp: string[] }
  retryAttempt: number
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
  private unsub: (() => void) | null = null
  private lastUserId: string | null = null
  private currentAsstId: string | null = null
  private stateListeners = new Set<(s: PiRuntimeUiState) => void>()
  /** last known runtime flags from events */
  private isCompactingFlag = false
  private retryAttempt = 0

  private constructor(runtime: AgentSessionRuntime) {
    this.runtime = runtime
    // permanent light subscription for queue/compaction/retry flags
    this.runtime.session.subscribe(event => {
      if (event.type === "compaction_start") this.isCompactingFlag = true
      if (event.type === "compaction_end") this.isCompactingFlag = false
      if (event.type === "auto_retry_start") {
        this.retryAttempt = Number((event as { attempt?: number }).attempt ?? 1)
      }
      if (event.type === "auto_retry_end") this.retryAttempt = 0
      if (event.type === "queue_update" || event.type === "thinking_level_changed") {
        this.emitState()
      }
    })
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

  private emitState() {
    const s = this.getRuntimeUiState()
    for (const l of this.stateListeners) l(s)
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

  getEntries(): unknown[] {
    return this.runtime.session.sessionManager.getEntries()
  }

  getTree(): unknown[] {
    return this.runtime.session.sessionManager.getTree()
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
      queue: { steering, followUp },
      retryAttempt: this.retryAttempt || session.retryAttempt || 0,
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

  async compact(customInstructions?: string): Promise<void> {
    await this.runtime.session.compact(customInstructions)
    this.emitState()
  }

  abortCompaction(): void {
    this.runtime.session.abortCompaction?.()
    this.isCompactingFlag = false
    this.emitState()
  }

  async prompt(
    text: string,
    onTick?: (p: ProjectionState) => void,
    opts?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> {
    const apply = (ev: WorkerEvent) => {
      this.projection = applyWorkerEvent(this.projection, ev)
      onTick?.(this.projection)
      this.emitState()
    }

    this.unsub?.()
    this.unsub = this.runtime.session.subscribe(event => {
      for (const wev of mapPiEventToWorker(event, this)) {
        apply(wev)
      }
      // state-only events
      if (
        event.type === "queue_update" ||
        event.type === "compaction_start" ||
        event.type === "compaction_end" ||
        event.type === "auto_retry_start" ||
        event.type === "auto_retry_end" ||
        event.type === "thinking_level_changed"
      ) {
        if (event.type === "compaction_start") this.isCompactingFlag = true
        if (event.type === "compaction_end") this.isCompactingFlag = false
        if (event.type === "auto_retry_start") {
          this.retryAttempt = Number((event as { attempt?: number }).attempt ?? 1)
        }
        if (event.type === "auto_retry_end") this.retryAttempt = 0
        this.emitState()
      }
    })

    try {
      if (opts?.deliverAs && this.runtime.session.isStreaming) {
        if (opts.deliverAs === "steer") {
          await this.runtime.session.steer(text)
        } else {
          await this.runtime.session.followUp(text)
        }
        // wait until idle if possible
        await this.runtime.session.waitForIdle?.()
      } else {
        await this.runtime.session.prompt(text)
      }
    } finally {
      apply({ type: "agent_end" })
      this.unsub?.()
      this.unsub = null
      this.projection = projectNativeBranch(this.runtime.session.sessionManager.getBranch())
      onTick?.(this.projection)
      this.emitState()
    }
  }

  async abort(): Promise<void> {
    await this.runtime.session.abort()
    this.emitState()
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
    this.unsub?.()
    this.unsub = null
    this.stateListeners.clear()
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
