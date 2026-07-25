import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import {
  getPiWorkerEntryUrl,
  restoreProjection,
  type PiCommandInfo,
  type PiModelInfo,
  type PiRuntimeUiState,
  type PiSessionInfo,
  type PiSessionRuntime,
  type PiSkillInfo,
  type ProjectionState,
  type WorkerCommand,
  type WorkerMessage,
  type WorkerResult,
  type WorkerSessionWire,
} from "@piui/pi-worker"

interface PendingRequest {
  resolve: (result: WorkerResult) => void
  reject: (error: Error) => void
}

export class PiWorkerSession implements PiSessionRuntime {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly stateListeners = new Set<(state: PiRuntimeUiState) => void>()
  private child: ChildProcess
  private session!: WorkerSessionWire
  private runtimeState!: PiRuntimeUiState
  private projection: ProjectionState = restoreProjection([])
  private projectionListener?: (projection: ProjectionState) => void
  private disposed = false

  private constructor(child: ChildProcess) {
    this.child = child
    child.on("message", message => this.handleMessage(message as WorkerMessage))
    child.on("error", error => this.handleExit(error))
    child.on("exit", (code, signal) => {
      if (this.disposed) return
      this.handleExit(new Error(`Pi worker exited unexpectedly (${signal ?? code ?? "unknown"})`))
    })
  }

  static async open(cwd: string, sessionFile?: string, workerEntry = getPiWorkerEntryUrl()): Promise<PiWorkerSession> {
    const client = new PiWorkerSession(spawnWorker(workerEntry))
    try {
      const result = await client.request({ type: "open", cwd, sessionFile })
      client.applySession(expectSession(result))
      return client
    } catch (error) {
      client.terminate()
      throw error
    }
  }

  static async listAll(workerEntry = getPiWorkerEntryUrl()): Promise<PiSessionInfo[]> {
    const child = spawnWorker(workerEntry)
    const client = new PiWorkerSession(child)
    try {
      const result = await client.request({ type: "listAll" })
      if (result.type !== "sessions") throw new Error(`unexpected Pi worker result: ${result.type}`)
      return result.sessions
    } finally {
      await client.dispose()
    }
  }

  static async listModels(workerEntry = getPiWorkerEntryUrl()): Promise<PiModelInfo[]> {
    const client = new PiWorkerSession(spawnWorker(workerEntry))
    try {
      const result = await client.request({ type: "listModels" })
      if (result.type !== "models") throw new Error(`unexpected Pi worker result: ${result.type}`)
      return result.models
    } finally {
      await client.dispose()
    }
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

  private request(command: WorkerCommand): Promise<WorkerResult> {
    if (this.disposed || !this.child.connected) return Promise.reject(new Error("Pi worker is not connected"))
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
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private terminate(): void {
    if (this.child.connected) this.child.disconnect()
    if (!this.child.killed) this.child.kill()
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
