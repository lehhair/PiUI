import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { PI_PARITY_SDK_VERSION } from "@piui/protocol"
import {
  getPiWorkerEntryUrl,
  PI_WORKER_PROTOCOL_VERSION,
  restoreProjection,
  type PiCommandInfo,
  type PiModelInfo,
  type PiRuntimeUiState,
  type PiSessionInfo,
  type PiSessionRuntime,
  type PiSkillInfo,
  type PiWorkerCapability,
  type ProjectionState,
  type WorkerCommand,
  type WorkerHello,
  type WorkerMessage,
  type WorkerResult,
  type WorkerSessionWire,
} from "@piui/pi-worker"

interface PendingRequest {
  resolve: (result: WorkerResult) => void
  reject: (error: Error) => void
}

export interface PiWorkerCatalog {
  getHandshake(): Promise<WorkerHello>
  list(cwd: string): Promise<PiSessionInfo[]>
  listAll(): Promise<PiSessionInfo[]>
  listModels(): Promise<PiModelInfo[]>
  dispose(): Promise<void>
}

export interface PiWorkerHost {
  getHandshake(): Promise<WorkerHello>
  open(cwd: string, sessionFile?: string): Promise<PiWorkerSession>
  dispose(): Promise<void>
}

export class PiWorkerSession implements PiSessionRuntime {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly stateListeners = new Set<(state: PiRuntimeUiState) => void>()
  private readonly crashListeners = new Set<(error: Error) => void>()
  private child: ChildProcess
  private session!: WorkerSessionWire
  private runtimeState!: PiRuntimeUiState
  private projection: ProjectionState = restoreProjection([])
  private projectionListener?: (projection: ProjectionState) => void
  private disposed = false
  private readonly ready: Promise<WorkerHello>
  private resolveReady!: (hello: WorkerHello) => void
  private rejectReady!: (error: Error) => void
  private readySettled = false
  private exitHandled = false
  private workerHello?: WorkerHello
  private readonly readyTimer: NodeJS.Timeout

  private constructor(child: ChildProcess) {
    this.child = child
    this.ready = new Promise<WorkerHello>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.readyTimer = setTimeout(() => {
      this.rejectHandshake(new Error("Pi worker handshake timeout"))
      this.terminate()
    }, 15_000)
    this.readyTimer.unref()
    child.on("message", message => this.handleMessage(message as WorkerMessage))
    child.on("error", error => this.handleExit(error))
    child.on("exit", (code, signal) => {
      if (this.disposed) return
      this.handleExit(new Error(`Pi worker exited unexpectedly (${signal ?? code ?? "unknown"})`))
    })
  }

  static async open(cwd: string, sessionFile?: string, workerEntry = getPiWorkerEntryUrl()): Promise<PiWorkerSession> {
    return PiWorkerSession.createHost(workerEntry).open(cwd, sessionFile)
  }

  static async listAll(workerEntry = getPiWorkerEntryUrl()): Promise<PiSessionInfo[]> {
    const catalog = PiWorkerSession.createCatalog(workerEntry)
    try {
      return await catalog.listAll()
    } finally {
      await catalog.dispose()
    }
  }

  static async listModels(workerEntry = getPiWorkerEntryUrl()): Promise<PiModelInfo[]> {
    const catalog = PiWorkerSession.createCatalog(workerEntry)
    try {
      return await catalog.listModels()
    } finally {
      await catalog.dispose()
    }
  }

  static createCatalog(workerEntry = getPiWorkerEntryUrl()): PiWorkerCatalog {
    const client = new PiWorkerSession(spawnWorker(workerEntry))
    return {
      getHandshake: () => client.getWorkerHandshake(),
      list: cwd => client.listCatalogSessions({ type: "list", cwd }),
      listAll: () => client.listCatalogSessions({ type: "listAll" }),
      listModels: () => client.listCatalogModels(),
      dispose: () => client.dispose(),
    }
  }

  static createHost(workerEntry = getPiWorkerEntryUrl()): PiWorkerHost {
    const client = new PiWorkerSession(spawnWorker(workerEntry))
    let opened = false
    return {
      getHandshake: () => client.getWorkerHandshake(),
      open: async (cwd, sessionFile) => {
        if (opened) throw new Error("Pi worker host is already in use")
        opened = true
        try {
          const result = await client.request({ type: "open", cwd, sessionFile })
          client.applySession(expectSession(result))
          return client
        } catch (error) {
          await client.dispose()
          throw error
        }
      },
      dispose: () => client.dispose(),
    }
  }

  getWorkerHandshake(): Promise<WorkerHello> {
    return this.ready
  }

  getWorkerGeneration(): string | undefined {
    return this.workerHello?.generation
  }

  onCrash(listener: (error: Error) => void): () => void {
    this.crashListeners.add(listener)
    return () => this.crashListeners.delete(listener)
  }

  private async listCatalogSessions(
    command: Extract<WorkerCommand, { type: "list" | "listAll" }>,
  ): Promise<PiSessionInfo[]> {
    const result = await this.request(command)
    if (result.type !== "sessions") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.sessions
  }

  private async listCatalogModels(): Promise<PiModelInfo[]> {
    const result = await this.request({ type: "listModels" })
    if (result.type !== "models") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.models
  }

  onState(listener: (state: PiRuntimeUiState) => void): () => void {
    this.stateListeners.add(listener)
    listener(this.getRuntimeUiState())
    return () => this.stateListeners.delete(listener)
  }

  getProjection(): ProjectionState { return this.projection }
  getSessionId(): string { return this.session.sessionId }
  getSessionFile(): string | undefined { return this.session.sessionFile }
  getSessionName(): string | undefined { return this.session.sessionName }
  getEntries(): unknown[] { return this.session.entries }
  getTree(): unknown[] { return this.session.tree }
  getLeafId(): string | null { return this.session.leafId }
  getModel() { return this.runtimeState.model }
  getThinkingLevel(): string { return this.runtimeState.thinkingLevel }
  getAvailableThinkingLevels(): string[] { return this.runtimeState.availableThinkingLevels }
  isStreaming(): boolean { return this.runtimeState.isStreaming }
  getRuntimeUiState(): PiRuntimeUiState { return this.runtimeState }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "setModel", provider, modelId })))
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "setThinkingLevel", level })))
  }

  async compact(customInstructions?: string): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "compact", instructions: customInstructions })))
  }

  async prompt(
    text: string,
    onTick?: (projection: ProjectionState) => void,
    opts?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> {
    this.projectionListener = onTick
    try {
      const result = await this.request({ type: "prompt", text, deliverAs: opts?.deliverAs })
      this.applySession(expectSession(result))
      onTick?.(this.projection)
    } finally {
      this.projectionListener = undefined
    }
  }

  async abort(): Promise<void> {
    this.applySession(expectSession(await this.request({ type: "abort" })))
  }

  async listSkills(): Promise<PiSkillInfo[]> {
    const result = await this.request({ type: "listSkills" })
    if (result.type !== "skills") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.skills
  }

  async listCommands(): Promise<PiCommandInfo[]> {
    const result = await this.request({ type: "listCommands" })
    if (result.type !== "commands") throw new Error(`unexpected Pi worker result: ${result.type}`)
    return result.commands
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.request({ type: "dispose" }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Pi worker dispose timeout")), 3000)
          timer.unref()
        }),
      ])
    } catch {
      /* terminate below */
    } finally {
      if (timer) clearTimeout(timer)
      this.disposed = true
      this.terminate()
    }
  }

  private async request(command: WorkerCommand): Promise<WorkerResult> {
    const hello = await this.ready
    if (this.disposed || !this.child.connected) return Promise.reject(new Error("Pi worker is not connected"))
    const requiredCapability = workerCapabilityFor(command)
    if (requiredCapability && !hello.capabilities.includes(requiredCapability)) {
      throw Object.assign(new Error(`Pi worker does not support ${requiredCapability}`), {
        code: "CAPABILITY_DISABLED",
      })
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.send({ kind: "request", id, command }, error => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private handleMessage(message: WorkerMessage): void {
    if (message.kind === "hello") {
      if (message.workerProtocolVersion !== PI_WORKER_PROTOCOL_VERSION) {
        this.rejectHandshake(
          Object.assign(
            new Error(
              `Pi worker protocol mismatch: expected ${PI_WORKER_PROTOCOL_VERSION}, received ${message.workerProtocolVersion}`,
            ),
            { code: "WORKER_PROTOCOL_MISMATCH" },
          ),
        )
        this.terminate()
        return
      }
      if (message.piSdkVersion !== PI_PARITY_SDK_VERSION) {
        this.rejectHandshake(
          Object.assign(
            new Error(`Pi SDK mismatch: expected ${PI_PARITY_SDK_VERSION}, received ${message.piSdkVersion}`),
            { code: "PI_SDK_VERSION_MISMATCH" },
          ),
        )
        this.terminate()
        return
      }
      this.readySettled = true
      clearTimeout(this.readyTimer)
      this.workerHello = message
      this.resolveReady(message)
      return
    }
    if (message.kind === "response") {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
      return
    }
    if (message.type === "projection") {
      this.projection = restoreProjection(message.projection.timeline, message.projection.isStreaming)
      this.projectionListener?.(this.projection)
      return
    }
    this.runtimeState = message.state
    for (const listener of this.stateListeners) listener(message.state)
  }

  private applySession(session: WorkerSessionWire): void {
    this.session = session
    this.runtimeState = session.state
    this.projection = restoreProjection(session.projection.timeline, session.projection.isStreaming)
  }

  private handleExit(error: Error): void {
    if (this.exitHandled) return
    this.exitHandled = true
    this.rejectHandshake(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (!this.disposed) {
      for (const listener of this.crashListeners) listener(error)
    }
  }

  private rejectHandshake(error: Error): void {
    if (this.readySettled) return
    this.readySettled = true
    clearTimeout(this.readyTimer)
    this.rejectReady(error)
  }

  private terminate(): void {
    if (this.child.connected) this.child.disconnect()
    if (!this.child.killed) this.child.kill()
  }
}

function workerCapabilityFor(command: WorkerCommand): PiWorkerCapability | undefined {
  switch (command.type) {
    case "list":
    case "listAll":
      return "catalog.sessions"
    case "listModels":
      return "catalog.models"
    case "open":
      return "runtime.open"
    case "prompt":
      return "runtime.prompt"
    case "abort":
      return "runtime.abort"
    case "setModel":
      return "runtime.model"
    case "setThinkingLevel":
      return "runtime.thinking"
    case "compact":
      return "runtime.compact"
    case "listSkills":
      return "runtime.skills"
    case "listCommands":
      return "runtime.commands"
    case "dispose":
      return undefined
  }
}

function spawnWorker(workerEntry: URL): ChildProcess {
  return fork(fileURLToPath(workerEntry), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: process.env,
  })
}

function expectSession(result: WorkerResult): WorkerSessionWire {
  if (result.type !== "session") throw new Error(`unexpected Pi worker result: ${result.type}`)
  return result.session
}
