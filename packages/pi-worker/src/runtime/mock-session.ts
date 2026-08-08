import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { realpath } from "node:fs/promises"
import type { ImageInput, JsonObject, JsonValue, RegistrySnapshot } from "@piui/protocol"
import { isJsonObject } from "@piui/protocol"
import type { CatalogProvider, PiEventMeta, SessionRuntime, Unsubscribe } from "../runtime.js"
import type { PackagesGateway } from "../command-table.js"
import {
  entriesPageFromEntries,
  sessionHeadFromParts,
  type EntriesPage,
  type LiveMessage,
  type SessionHead,
} from "./pagination.js"

const MOCK_SDK_VERSION = "mock"

function mockHome(): string {
  return process.env.PIUI_MOCK_DIR?.trim() || path.join(tmpdir(), "piui-mock")
}

function sessionsDir(): string {
  return path.join(mockHome(), "sessions")
}

function nowIso(): string {
  return new Date().toISOString()
}

export class MockStore {
  list(): JsonObject[] {
    const dir = sessionsDir()
    if (!existsSync(dir)) return []
    return readDirJsonl(dir)
  }

  open(sessionFile: string): { header: JsonObject | null; entries: JsonObject[] } {
    return readJsonlFile(sessionFile)
  }

  create(cwd: string): { sessionFile: string; sessionId: string } {
    const dir = sessionsDir()
    mkdirSync(dir, { recursive: true })
    const sessionId = randomUUID()
    const sessionFile = path.join(dir, `${sessionId}.jsonl`)
    const header: JsonObject = {
      type: "session",
      version: 1,
      id: sessionId,
      cwd,
      timestamp: nowIso(),
    }
    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8")
    return { sessionFile, sessionId }
  }

  async delete(sessionFile: string): Promise<void> {
    await fs.unlink(sessionFile)
  }
}

function readDirJsonl(dir: string): JsonObject[] {
  const result: JsonObject[] = []
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith(".jsonl")) continue
    const file = path.join(dir, name)
    try {
      const { header, entries } = readJsonlFile(file)
      const id = typeof header?.id === "string" ? header.id : path.basename(name, ".jsonl")
      const messages = entries.filter(entry => entry.type === "message")
      const firstUser = messages.find(entry => isJsonObject(entry.message) && entry.message.role === "user")
      result.push({
        id,
        path: file,
        cwd: typeof header?.cwd === "string" ? header.cwd : "",
        name: typeof header?.name === "string" ? header.name : null,
        parentSessionPath: typeof header?.parentSession === "string" ? header.parentSession : null,
        created: typeof header?.timestamp === "string" ? header.timestamp : nowIso(),
        modified: lastTimestamp(entries) ?? (typeof header?.timestamp === "string" ? header.timestamp : nowIso()),
        messageCount: messages.length,
        firstMessage: firstUser && isJsonObject(firstUser.message)
          ? textFromContent(firstUser.message.content).slice(0, 120)
          : "",
      })
    } catch {
      /* skip corrupted mock session files */
    }
  }
  result.sort((a, b) => String(b.modified).localeCompare(String(a.modified)))
  return result
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readJsonlFile(file: string): { header: JsonObject | null; entries: JsonObject[] } {
  const lines = readFileSync(file, "utf8").split("\n").filter(line => line.trim())
  let header: JsonObject | null = null
  const entries: JsonObject[] = []
  for (const line of lines) {
    const value = JSON.parse(line) as unknown
    if (!isJsonObject(value)) continue
    if (value.type === "session") header = value
    else entries.push(value)
  }
  return { header, entries }
}

async function assertMockSessionFileInside(sessionFile: string): Promise<void> {
  const root = await realpath(sessionsDir())
  const target = await realpath(sessionFile)
  const rootKey = process.platform === "win32" ? root.toLowerCase() : root
  const targetKey = process.platform === "win32" ? target.toLowerCase() : target
  if (targetKey !== rootKey && !targetKey.startsWith(rootKey + path.sep)) {
    throw Object.assign(new Error("Mock session file is outside the session directory"), { code: "PATH_OUTSIDE_WORKSPACE" })
  }
}

function lastTimestamp(entries: JsonObject[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const ts = entries[index]?.timestamp
    if (typeof ts === "string") return ts
  }
  return undefined
}

function textFromContent(content: JsonValue | undefined): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(block => isJsonObject(block) && block.type === "text" && typeof block.text === "string")
    .map(block => String((block as JsonObject).text))
    .join("")
}

export class MockCatalog implements CatalogProvider, PackagesGateway {
  private readonly store = new MockStore()

  async listSessions(cwd: string): Promise<JsonValue> {
    return this.store.list().filter(info => info.cwd === cwd || !cwd)
  }

  async listAllSessions(): Promise<JsonValue> {
    return this.store.list()
  }

  async createSession(cwd: string): Promise<JsonValue> {
    return { ...this.store.create(cwd), cwd }
  }

  async previewSession(cwd: string, sessionFile: string, params: { cursor?: string; limit?: number; maxBytes?: number } = {}): Promise<JsonValue> {
    const info = this.store.list().find(item => item.path === sessionFile)
    if (!info) throw Object.assign(new Error("session file not found"), { code: "SESSION_NOT_FOUND" })
    const sessionId = typeof info.id === "string" ? info.id : "mock-session"
    const head = sessionHeadFromParts({
      sdkVersion: MOCK_SDK_VERSION,
      revision: 0,
      header: null,
      leafId: null,
      entryCount: 0,
    }, sessionId)
    const branch = entriesPageFromEntries(head, [], {
      cursor: params.cursor,
      limit: params.limit ?? 100,
      maxBytes: params.maxBytes ?? 2 * 1024 * 1024,
    }, entry => entry)
    return {
      state: {
        sessionId,
        sessionFile,
        sessionName: null,
        cwd,
        model: null,
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        autoRetryEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
        availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        isIdle: true,
        isBashRunning: false,
        hasPendingBashMessages: false,
        isRetrying: false,
        retryAttempt: 0,
        queue: { steering: [], followUp: [], steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
        supportsThinking: true,
        activeTools: [],
        scopedModels: [],
        sessionStats: {
          sessionFile: sessionFile,
          sessionId,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        },
        contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
        retry: null,
        compaction: null,
        head,
      },
      branch,
    }
  }

  async previewSessionById(sessionId: string, params: { cursor?: string; limit?: number; maxBytes?: number } = {}): Promise<JsonValue> {
    const info = this.store.list().find(item => item.id === sessionId)
    if (!info || typeof info.path !== "string" || typeof info.cwd !== "string") {
      throw Object.assign(new Error("session file not found"), { code: "SESSION_NOT_FOUND" })
    }
    return this.previewSession(info.cwd, info.path, params)
  }

  async deleteSession(_cwd: string, sessionFile: string): Promise<void> {
    const root = path.resolve(sessionsDir())
    const resolved = path.resolve(sessionFile)
    if (!existsSync(resolved)) throw Object.assign(new Error("session file not found"), { code: "SESSION_NOT_FOUND" })
    const realRoot = await fs.realpath(root)
    const realTarget = await fs.realpath(resolved)
    const rootKey = process.platform === "win32" ? realRoot.toLowerCase() : realRoot
    const resolvedKey = process.platform === "win32" ? realTarget.toLowerCase() : realTarget
    if (!resolvedKey.startsWith(rootKey + path.sep)) {
      throw Object.assign(new Error("session file is outside the mock session directory"), { code: "PATH_OUTSIDE_WORKSPACE" })
    }
    await this.store.delete(resolved)
  }

  async listModels(): Promise<JsonValue> {
    return [
      { provider: "mock", id: "mock", name: "Mock", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
    ]
  }

  getSettings(cwd: string): JsonValue {
    return { workspacePath: cwd, projectTrusted: true, global: {}, project: {}, effective: {}, errors: [] }
  }

  async patchSettings(cwd: string): Promise<JsonValue> {
    return this.getSettings(cwd)
  }

  getProjectTrust(cwd: string): JsonValue {
    return { workspacePath: cwd, required: false, decision: null, defaultDecision: "always", trusted: true }
  }

  setProjectTrust(cwd: string): JsonValue {
    return this.getProjectTrust(cwd)
  }

  list(): JsonValue {
    return []
  }

  async manage(): Promise<JsonValue> {
    return []
  }

  async resolve(): Promise<JsonValue> {
    return { resolved: [], missing: [] }
  }

  async resolveSources(): Promise<JsonValue> {
    return { resolved: [], missing: [] }
  }

  async changeSource(): Promise<JsonValue> {
    return { changed: false, packages: [] }
  }

  installedPath(): JsonValue {
    return null
  }

  async checkUpdates(): Promise<JsonValue> {
    return []
  }
}

interface MockEntry extends JsonObject {}

export class MockPiSession implements SessionRuntime {
  private header: JsonObject | null
  private entries: MockEntry[]
  private revision = 0
  private leafId: string | null = null
  private streaming = false
  private compacting = false
  private timers: NodeJS.Timeout[] = []
  private steeringQueue: string[] = []
  private followUpQueue: string[] = []
  private steeringMode: "all" | "one-at-a-time" = "all"
  private followUpMode: "all" | "one-at-a-time" = "one-at-a-time"
  private thinkingLevel = "off"
  private activeTools = ["mock-tool"]
  private dynamicToolRegistered = false
  private autoCompaction = true
  private autoRetry = true
  private eventEpoch = randomUUID()
  private eventSequence = 0
  private liveMessage?: LiveMessage
  private readonly piEventListeners = new Set<(event: JsonObject, meta: PiEventMeta) => void>()
  private readonly headListeners = new Set<(head: SessionHead) => void>()
  private readonly extensionUiListeners = new Set<(event: JsonObject) => void>()
  private readonly resourceListeners = new Set<() => void>()

  private constructor(
    private sessionFile: string | undefined,
    private readonly cwd: string,
    header: JsonObject | null,
    entries: MockEntry[],
  ) {
    this.header = header
    this.entries = entries
    this.leafId = typeof entries.at(-1)?.id === "string" ? entries.at(-1)!.id as string : null
  }

  static async open(cwd: string, sessionFile?: string): Promise<MockPiSession> {
    const store = new MockStore()
    if (sessionFile) {
      if (!existsSync(sessionFile)) {
        throw Object.assign(new Error("mock session file no longer exists"), { code: "SESSION_NOT_FOUND" })
      }
      const root = await realpath(sessionsDir())
      const target = await realpath(path.resolve(sessionFile))
      const rootKey = process.platform === "win32" ? root.toLowerCase() : root
      const targetKey = process.platform === "win32" ? target.toLowerCase() : target
      if (!targetKey.startsWith(rootKey + path.sep)) {
        throw Object.assign(new Error("mock session file is outside the session directory"), { code: "PATH_OUTSIDE_WORKSPACE" })
      }
      const { header, entries } = store.open(sessionFile)
      return new MockPiSession(sessionFile, cwd, header, entries)
    }
    const created = store.create(cwd)
    const { header, entries } = store.open(created.sessionFile)
    return new MockPiSession(created.sessionFile, cwd, header, entries)
  }

  getSessionId(): string {
    return typeof this.header?.id === "string" ? this.header.id : "mock-session"
  }

  getSessionFile(): string | undefined {
    return this.sessionFile
  }

  getCwd(): string {
    return this.cwd
  }

  onPiEvent(listener: (event: JsonObject, meta: PiEventMeta) => void): Unsubscribe {
    this.piEventListeners.add(listener)
    return () => this.piEventListeners.delete(listener)
  }

  onHead(listener: (head: SessionHead) => void): Unsubscribe {
    this.headListeners.add(listener)
    return () => this.headListeners.delete(listener)
  }

  onExtensionUi(listener: (event: JsonObject) => void): Unsubscribe {
    this.extensionUiListeners.add(listener)
    return () => this.extensionUiListeners.delete(listener)
  }

  onResourcesChanged(listener: () => void): Unsubscribe {
    this.resourceListeners.add(listener)
    return () => this.resourceListeners.delete(listener)
  }

  private emitEvent(event: JsonObject): void {
    const meta: PiEventMeta = { epoch: this.eventEpoch, sequence: ++this.eventSequence }
    if (this.liveMessage) meta.liveMessage = { id: this.liveMessage.id, revision: this.liveMessage.revision }
    for (const listener of this.piEventListeners) listener(event, meta)
  }

  private emitHead(): void {
    const head = this.getHead()
    for (const listener of this.headListeners) listener(head)
  }

  private persist(entry: JsonObject): void {
    this.entries.push(entry)
    this.leafId = typeof entry.id === "string" ? entry.id : this.leafId
    this.revision += 1
    if (this.sessionFile) appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`, "utf8")
    this.emitHead()
  }

  getHead(): SessionHead {
    return sessionHeadFromParts({
      sdkVersion: MOCK_SDK_VERSION,
      revision: this.revision,
      header: this.header,
      leafId: this.leafId,
      entryCount: this.entries.length,
    }, this.getSessionId())
  }

  getEntriesPage(cursor: string | undefined, limit: number, maxBytes: number): EntriesPage {
    return entriesPageFromEntries(this.getHead(), this.entries, { cursor, limit, maxBytes }, entry => entry)
  }

  getBranchPage(cursor: string | undefined, limit: number, maxBytes: number): EntriesPage {
    const byId = new Map(this.entries.map(entry => [String(entry.id), entry]))
    const branch: MockEntry[] = []
    const visited = new Set<string>()
    let id: string | null = this.leafId
    while (id && !visited.has(id)) {
      visited.add(id)
      const entry = byId.get(id)
      if (!entry) break
      branch.unshift(entry)
      id = typeof entry.parentId === "string" ? entry.parentId : null
    }
    const checkpoint = cursor ? undefined : {
      position: { epoch: this.eventEpoch, sequence: this.eventSequence },
      liveMessage: this.liveMessage,
    }
    return entriesPageFromEntries(this.getHead(), branch, { cursor, limit, maxBytes, checkpoint }, entry => entry)
  }

  getTree(): JsonValue {
    return this.entries.map(entry => ({
      id: entry.id ?? null,
      parentId: entry.parentId ?? null,
      label: entry.label ?? null,
    }))
  }

  getAttachment(): JsonObject {
    throw Object.assign(new Error("mock sessions have no attachments"), { code: "NOT_FOUND" })
  }

  getState(): JsonObject {
    return {
      sessionId: this.getSessionId(),
      sessionFile: this.sessionFile ?? null,
      sessionName: typeof this.header?.name === "string" ? this.header.name : null,
      cwd: this.cwd,
      model: { provider: "mock", id: "mock", name: "Mock" },
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.streaming,
      isCompacting: this.compacting,
      steeringMode: this.steeringMode,
      followUpMode: this.followUpMode,
      autoCompactionEnabled: this.autoCompaction,
      autoRetryEnabled: this.autoRetry,
      messageCount: this.entries.length,
      pendingMessageCount: this.steeringQueue.length + this.followUpQueue.length,
      availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
      isIdle: !this.streaming,
      isBashRunning: false,
      hasPendingBashMessages: false,
      isRetrying: false,
      retryAttempt: 0,
      queue: {
        steering: [...this.steeringQueue],
        followUp: [...this.followUpQueue],
        steeringMode: this.steeringMode,
        followUpMode: this.followUpMode,
      },
      supportsThinking: true,
      activeTools: [...this.activeTools],
      scopedModels: [],
      // 与真实 SDK getSessionStats/getContextUsage 形状一致（mock 无真实消耗）
      sessionStats: {
        sessionFile: this.sessionFile ?? null,
        sessionId: this.getSessionId(),
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: this.entries.length,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      },
      contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
      retry: { phase: "idle", autoEnabled: this.autoRetry },
      compaction: { autoEnabled: this.autoCompaction, operation: { type: "none" } },
      head: this.getHead(),
    }
  }

  listSkills(): JsonValue {
    return []
  }

  listPrompts(): JsonValue {
    return []
  }

  listAgentsFiles(): JsonValue {
    return []
  }

  getRegistry(): RegistrySnapshot {
    const tools: RegistrySnapshot["tools"] = [
      {
        name: "mock-tool",
        description: "Mock tool for tests",
        parameters: { type: "object", properties: { echo: { type: "string" } } },
        sourceInfo: { source: "builtin" },
      },
    ]
    if (this.dynamicToolRegistered) {
      tools.push({
        name: "mock-dynamic-tool",
        description: "Mock dynamically registered tool",
        parameters: { type: "object", properties: { value: { type: "string" } } },
        sourceInfo: { source: "dynamic" },
      })
    }
    return {
      sdkVersion: MOCK_SDK_VERSION,
      tools,
      activeTools: [...this.activeTools],
      commands: [
        { name: "mock-command", description: "Mock extension command", sourceInfo: { source: "builtin" } },
      ],
      extensions: [],
      eventHandlers: [],
    }
  }

  private schedule(fn: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers = this.timers.filter(item => item !== timer)
      fn()
    }, delayMs)
    this.timers.push(timer)
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  private appendUserMessage(text: string, images?: ImageInput[]): JsonObject {
    const timestamp = Date.now()
    const content: JsonValue = images?.length
      ? [{ type: "text", text }, ...images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType }))]
      : text
    const entry: JsonObject = {
      type: "message",
      id: `mock-user-${randomUUID()}`,
      parentId: this.leafId,
      timestamp: nowIso(),
      message: { role: "user", timestamp, content },
    }
    this.persist(entry)
    return entry
  }

  private runMockTurn(userText: string): void {
    const full = `Mock reply to: ${userText}`
    const chunks = [full.slice(0, Math.ceil(full.length / 2)), full]
    const messageId = randomUUID()
    this.streaming = true
    this.emitEvent({ type: "agent_start" })
    this.schedule(() => {
      const message: JsonObject = {
        role: "assistant",
        timestamp: Date.now(),
        provider: "mock",
        model: "mock",
        stopReason: "stop",
        content: [{ type: "text", text: chunks[0] }],
      }
      this.liveMessage = { id: messageId, revision: 1, phase: "streaming", message }
      this.emitEvent({ type: "message_start", message })
    }, 5)
    this.schedule(() => {
      const message: JsonObject = {
        role: "assistant",
        timestamp: Date.now(),
        provider: "mock",
        model: "mock",
        stopReason: "stop",
        content: [{ type: "text", text: chunks[1] ?? full }],
      }
      this.liveMessage = { id: messageId, revision: 2, phase: "streaming", message }
      this.emitEvent({ type: "message_update", message })
    }, 15)
    this.schedule(() => {
      const message: JsonObject = {
        role: "assistant",
        timestamp: Date.now(),
        provider: "mock",
        model: "mock",
        stopReason: "stop",
        content: [{ type: "text", text: full }],
      }
      this.liveMessage = { id: messageId, revision: 3, phase: "persisting", message }
      this.emitEvent({ type: "message_end", message })
      this.persist({
        type: "message",
        id: `mock-assistant-${randomUUID()}`,
        parentId: this.leafId,
        timestamp: nowIso(),
        message,
      })
      this.liveMessage = undefined
      this.streaming = false
      this.emitEvent({ type: "agent_end" })
      this.drainQueue()
    }, 25)
  }

  private drainQueue(): void {
    const next = this.steeringQueue.shift() ?? this.followUpQueue.shift()
    if (next !== undefined) {
      const entry = this.appendUserMessage(next)
      const text = textFromContent((entry.message as JsonObject).content)
      this.runMockTurn(text)
    }
  }

  async prompt(text: string, _images?: ImageInput[], options: { expandPromptTemplates?: boolean; streamingBehavior?: "steer" | "followUp" } = {}): Promise<void> {
    if (this.streaming) {
      if (!options.streamingBehavior) {
        throw Object.assign(new Error("mock session is already streaming"), { code: "SESSION_BUSY" })
      }
      if (options.streamingBehavior === "followUp") return this.followUp(text)
      return this.steer(text)
    }
    this.appendUserMessage(text)
    this.runMockTurn(text)
  }

  async steer(text: string): Promise<void> {
    if (!this.streaming) throw Object.assign(new Error("Cannot steer an idle mock session"), { code: "SESSION_CONFLICT" })
    this.steeringQueue.push(text)
    this.emitEvent({ type: "queue_update", steering: [...this.steeringQueue], followUp: [...this.followUpQueue] })
  }

  async followUp(text: string): Promise<void> {
    if (!this.streaming) throw Object.assign(new Error("Cannot queue a follow-up on an idle mock session"), { code: "SESSION_CONFLICT" })
    this.followUpQueue.push(text)
    this.emitEvent({ type: "queue_update", steering: [...this.steeringQueue], followUp: [...this.followUpQueue] })
  }

  async sendUserMessage(text: string, images?: ImageInput[], deliverAs?: "steer" | "followUp"): Promise<void> {
    if (deliverAs === "steer") return this.steer(text)
    if (deliverAs === "followUp") return this.followUp(text)
    return this.prompt(text)
  }

  async abort(): Promise<JsonValue | undefined> {
    const cleared = { steering: [...this.steeringQueue], followUp: [...this.followUpQueue] }
    this.steeringQueue = []
    this.followUpQueue = []
    this.clearTimers()
    if (this.streaming) {
      this.streaming = false
      this.liveMessage = undefined
      this.emitEvent({ type: "agent_end" })
    }
    return cleared
  }

  async newSession(parentSession?: string): Promise<JsonObject> {
    const sourceSessionId = this.getSessionId()
    const store = new MockStore()
    const created = store.create(this.cwd)
    const { header, entries } = store.open(created.sessionFile)
    if (parentSession) header!.parentSession = parentSession
    this.header = header
    this.entries = entries
    this.sessionFileReplace(created.sessionFile)
    this.resetLive()
    this.emitHead()
    return {
      operation: "new",
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: created.sessionFile,
      targetCwd: this.cwd,
      cancelled: false,
    }
  }

  async switchSession(sessionPath: string): Promise<JsonObject> {
    const sourceSessionId = this.getSessionId()
    const store = new MockStore()
    const targetPath = path.resolve(sessionPath)
    await assertMockSessionFileInside(targetPath)
    if (!existsSync(targetPath)) throw Object.assign(new Error("mock session file not found"), { code: "SESSION_NOT_FOUND" })
    const { header, entries } = store.open(targetPath)
    this.header = header
    this.entries = entries
    this.sessionFileReplace(targetPath)
    this.resetLive()
    this.emitHead()
    return {
      operation: "switch",
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: targetPath,
      targetCwd: this.cwd,
      cancelled: false,
    }
  }

  async fork(entryId: string): Promise<JsonObject> {
    const sourceSessionId = this.getSessionId()
    const store = new MockStore()
    const created = store.create(this.cwd)
    const index = this.entries.findIndex(entry => entry.id === entryId)
    if (index < 0) throw Object.assign(new Error("entry not found"), { code: "NOT_FOUND" })
    const carried = this.entries.slice(0, index + 1)
    for (const entry of carried) appendFileSync(created.sessionFile, `${JSON.stringify(entry)}\n`, "utf8")
    this.entries = carried.map(entry => ({ ...entry }))
    this.header = { type: "session", version: 1, id: created.sessionId, cwd: this.cwd, timestamp: nowIso(), parentSession: this.sessionFile ?? null }
    this.sessionFileReplace(created.sessionFile)
    this.resetLive()
    this.emitHead()
    return {
      operation: "fork",
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: created.sessionFile,
      targetCwd: this.cwd,
      cancelled: false,
    }
  }

  async importSession(inputPath: string): Promise<JsonObject> {
    const sourceSessionId = this.getSessionId()
    if (!existsSync(inputPath)) throw Object.assign(new Error("import file not found"), { code: "NOT_FOUND" })
    const store = new MockStore()
    const created = store.create(this.cwd)
    const content = readFileSync(inputPath, "utf8")
    writeFileSync(created.sessionFile, content, "utf8")
    const { header, entries } = store.open(created.sessionFile)
    this.header = header
    this.entries = entries
    this.sessionFileReplace(created.sessionFile)
    this.resetLive()
    this.emitHead()
    return {
      operation: "import",
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: created.sessionFile,
      targetCwd: this.cwd,
      cancelled: false,
    }
  }

  private sessionFileReplace(next: string): void {
    this.sessionFile = next
  }

  private resetLive(): void {
    this.clearTimers()
    this.streaming = false
    this.liveMessage = undefined
    this.leafId = typeof this.entries.at(-1)?.id === "string" ? this.entries.at(-1)!.id as string : null
    this.revision += 1
    this.eventEpoch = randomUUID()
    this.eventSequence = 0
  }

  async setSessionName(name: string): Promise<void> {
    this.header = { ...this.header, name }
  }

  async setModel(): Promise<void> {}

  async cycleModel(): Promise<void> {}

  async setScopedModels(): Promise<JsonValue | undefined> {
    return []
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.thinkingLevel = level
  }

  async cycleThinkingLevel(): Promise<JsonValue | undefined> {
    const levels = ["off", "minimal", "low", "medium", "high"]
    const index = levels.indexOf(this.thinkingLevel)
    this.thinkingLevel = levels[(index + 1) % levels.length]!
    return this.thinkingLevel
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    this.steeringMode = mode
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    this.followUpMode = mode
  }

  async clearQueue(): Promise<JsonValue | undefined> {
    const cleared = { steering: [...this.steeringQueue], followUp: [...this.followUpQueue] }
    this.steeringQueue = []
    this.followUpQueue = []
    return cleared
  }

  async compact(): Promise<JsonValue | undefined> {
    return {
      status: "completed",
      result: {
        summary: "Mock compaction summary",
        firstKeptEntryId: this.entries[0]?.id ?? "",
        tokensBefore: 1000,
        estimatedTokensAfter: 100,
      },
    }
  }

  async abortCompaction(): Promise<void> {}

  async abortBranchSummary(): Promise<void> {}

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.autoCompaction = enabled
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    this.autoRetry = enabled
  }

  async abortRetry(): Promise<void> {}

  async bash(command: string): Promise<JsonValue | undefined> {
    return { output: `mock bash: ${command}`, exitCode: 0, cancelled: false, truncated: false }
  }

  async abortBash(): Promise<void> {}

  async setActiveTools(toolNames: string[]): Promise<void> {
    this.activeTools = [...toolNames]
  }

  async invokeTool(name: string, args?: JsonObject): Promise<JsonValue | undefined> {
    if (name === "mock-dynamic-tool" && this.dynamicToolRegistered) {
      return { content: [{ type: "text", text: `mock-dynamic-tool value: ${String(args?.value ?? "")}` }], details: {} }
    }
    if (name !== "mock-tool") throw Object.assign(new Error(`tool not found: ${name}`), { code: "NOT_FOUND" })
    return { content: [{ type: "text", text: `mock-tool echo: ${String(args?.echo ?? "")}` }], details: {} }
  }

  async invokeCommand(name: string): Promise<JsonValue | undefined> {
    if (name !== "mock-command") throw Object.assign(new Error(`command not found: ${name}`), { code: "NOT_FOUND" })
    this.dynamicToolRegistered = true
    return undefined
  }

  async navigateTree(entryId: string): Promise<JsonObject> {
    const entry = this.entries.find(item => item.id === entryId)
    if (!entry) throw Object.assign(new Error("entry not found"), { code: "NOT_FOUND" })
    this.leafId = entryId
    this.revision += 1
    this.emitHead()
    return { editorText: "", cancelled: false }
  }

  async setLabel(entryId: string, label?: string): Promise<void> {
    const entry = this.entries.find(item => item.id === entryId)
    if (!entry) throw Object.assign(new Error("entry not found"), { code: "NOT_FOUND" })
    if (label === undefined) delete entry.label
    else entry.label = label
    this.revision += 1
    this.emitHead()
  }

  async sendCustomMessage(): Promise<void> {}

  async appendCustomEntry(customType: string, data?: JsonValue): Promise<void> {
    this.persist({
      type: "custom",
      customType,
      data: data ?? null,
      id: `mock-custom-${randomUUID()}`,
      parentId: this.leafId,
      timestamp: nowIso(),
    })
  }

  async exportHtml(outputPath: string): Promise<JsonValue | undefined> {
    writeFileSync(outputPath, "<html><body>mock export</body></html>", "utf8")
    return { path: outputPath }
  }

  async exportJsonl(outputPath: string): Promise<JsonValue | undefined> {
    const lines = [this.header, ...this.entries].filter(Boolean).map(value => JSON.stringify(value))
    writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8")
    return { path: outputPath }
  }

  async waitForIdle(): Promise<void> {
    while (this.streaming) await new Promise(resolve => setTimeout(resolve, 5))
  }

  async reload(): Promise<void> {
    for (const listener of this.resourceListeners) listener()
  }

  async respondExtensionUi(): Promise<boolean> {
    return false
  }

  async setExtensionEditorState(): Promise<void> {}

  async dispose(): Promise<void> {
    this.streaming = false
    this.compacting = false
    this.clearTimers()
    this.piEventListeners.clear()
    this.headListeners.clear()
    this.extensionUiListeners.clear()
    this.resourceListeners.clear()
  }
}
