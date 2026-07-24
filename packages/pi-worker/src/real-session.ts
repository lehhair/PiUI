/**
 * Real Pi AgentSessionRuntime wrapper.
 * Only used when PIUI_DRIVER=pi. Will call configured models.
 */
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent"
import {
  applyWorkerEvent,
  createProjectionState,
  type ProjectionState,
} from "./projection.js"
import type { PiContentBlock, WorkerEvent } from "./types.js"

export class RealPiSession {
  private runtime: AgentSessionRuntime
  private projection: ProjectionState = createProjectionState()
  private unsub: (() => void) | null = null
  private lastUserId: string | null = null
  private currentAsstId: string | null = null

  private constructor(runtime: AgentSessionRuntime) {
    this.runtime = runtime
  }

  static async open(cwd: string): Promise<RealPiSession> {
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: runtimeCwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({ cwd: runtimeCwd })
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

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.create(cwd),
    })

    await runtime.session.bindExtensions({})
    return new RealPiSession(runtime)
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

  getModel() {
    const m = this.runtime.session.model
    if (!m) return undefined
    return { provider: m.provider, id: m.id, displayName: m.name ?? m.id }
  }

  getThinkingLevel(): string {
    return String(this.runtime.session.thinkingLevel ?? "off")
  }

  isStreaming(): boolean {
    return this.runtime.session.isStreaming
  }

  async prompt(text: string, onTick?: (p: ProjectionState) => void): Promise<void> {
    const apply = (ev: WorkerEvent) => {
      this.projection = applyWorkerEvent(this.projection, ev)
      onTick?.(this.projection)
    }

    this.unsub?.()
    this.unsub = this.runtime.session.subscribe(event => {
      for (const wev of mapPiEventToWorker(event, this)) {
        apply(wev)
      }
    })

    try {
      await this.runtime.session.prompt(text)
    } finally {
      apply({ type: "agent_end" })
      this.unsub?.()
      this.unsub = null
    }
  }

  async abort(): Promise<void> {
    await this.runtime.session.abort()
  }

  async dispose(): Promise<void> {
    this.unsub?.()
    this.unsub = null
    await this.runtime.dispose()
  }

  /** internal helpers for mapper */
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
