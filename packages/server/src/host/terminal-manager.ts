import { randomUUID } from "node:crypto"
import path from "node:path"
import { lstat } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import type { IPty } from "@lydell/node-pty"

type PtyModule = { spawn: (file: string, args: string[], options: object) => IPty }
let ptyModule: PtyModule | undefined

/**
 * 编译形态（PIUI_NATIVE_MODULES 指向 exe 旁的 node_modules）按绝对路径
 * 直接加载平台包——Bun 编译产物的 require 不会为磁盘上的外部模块做
 * node_modules 上溯解析，node-pty 的包装包在里面会找不到平台二进制，
 * 所以绕过包装层。开发态走正常解析。
 */
function loadPty(): PtyModule {
  if (ptyModule) return ptyModule
  const nativeRoot = process.env.PIUI_NATIVE_MODULES?.trim()
  if (nativeRoot) {
    const platformEntry = join(nativeRoot, "@lydell", `node-pty-${process.platform}-${process.arch}`, "package.json")
    ptyModule = createRequire(platformEntry)(`@lydell/node-pty-${process.platform}-${process.arch}`) as PtyModule
  } else {
    ptyModule = createRequire(import.meta.url)("@lydell/node-pty") as PtyModule
  }
  return ptyModule
}
import type {
  EventChannel,
  TerminalCreateParams,
  TerminalInfo,
  TerminalUpdateParams,
} from "@piui/protocol"
import { resolveWorkspacePath } from "./path-safety.ts"
import { workspacePathKey } from "./workspace-store.ts"

const OUTPUT_BUFFER_LIMIT = 2 * 1024 * 1024
const EXITED_SESSION_LIMIT = 25
const TERMINAL_LIMIT = 32
const TICKET_TTL_MS = 60_000

type TerminalEventChannel = Extract<EventChannel, `terminal.${string}`>

type Subscriber = {
  active: boolean
  pending: string[]
  end?: { exitCode: number | null }
  pendingTitle?: string
  onData: (data: string) => void
  onEnd: (event: { exitCode: number | null }) => void
  onTitle: (title: string) => void
}

type ActiveTerminal = {
  workspacePath: string
  info: TerminalInfo
  process: IPty
  customTitle?: string
  titleBuffer: string
  output: string
  bufferCursor: number
  subscribers: Map<object, Subscriber>
  listeners: Array<{ dispose(): void }>
}

type TerminalTicket = {
  terminalId: string
  workspacePath: string
  expiresAt: number
}

export type TerminalAttachment = {
  replay: string
  replayCursor: number
  cursor: number
  activate(): void
  detach(): void
}

export type TerminalManagerOptions = {
  publish?: (workspacePath: string, channel: TerminalEventChannel, payload: TerminalInfo) => void
}

export class TerminalManager {
  private readonly terminals = new Map<string, ActiveTerminal>()
  private readonly exitedOrder: string[] = []
  private readonly tickets = new Map<string, TerminalTicket>()
  /** Processes whose kill failed and whose handle must be retried at dispose. */
  private readonly staleProcesses: IPty[] = []
  /** Creates still awaiting async cwd resolution; counts toward the limit. */
  private pendingCreates = 0

  constructor(private readonly options: TerminalManagerOptions = {}) {}

  list(workspacePath: string): TerminalInfo[] {
    return Array.from(this.terminals.values())
      .filter(terminal => workspacePathKey(terminal.workspacePath) === workspacePathKey(workspacePath))
      .map(terminal => ({ ...terminal.info }))
  }

  get(workspacePath: string, id: string): TerminalInfo {
    return { ...this.require(workspacePath, id).info }
  }

  async create(workspacePath: string, params: TerminalCreateParams = {}): Promise<TerminalInfo> {
    // Reserve a slot synchronously so concurrent creates cannot all pass the
    // limit check while an earlier one is still awaiting its working directory.
    if (this.terminals.size + this.pendingCreates >= TERMINAL_LIMIT) {
      throw Object.assign(new Error("terminal limit reached"), { code: "TERMINAL_LIMIT_REACHED" })
    }
    this.pendingCreates += 1
    try {
      return await this.createReserved(workspacePath, params)
    } finally {
      this.pendingCreates -= 1
    }
  }

  private async createReserved(workspacePath: string, params: TerminalCreateParams): Promise<TerminalInfo> {
    const cwd = await this.resolveCwd(workspacePath, params.cwd)
    const shell = resolveShell(params.shell)
    const size = terminalSize(params.rows, params.cols)
    const id = `term_${randomUUID()}`
    const customTitle = params.title?.trim() || undefined
    const title = customTitle || path.basename(shell) || "Terminal"
    const environment = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PIUI_TERMINAL: "1",
    }

    let child: IPty
    try {
      child = loadPty().spawn(shell, shellArgs(shell), {
        name: "xterm-256color",
        cwd,
        cols: size.cols,
        rows: size.rows,
        env: environment,
      })
    } catch (error) {
      throw Object.assign(new Error(`failed to start terminal: ${error instanceof Error ? error.message : String(error)}`), {
        code: "TERMINAL_START_FAILED",
      })
    }

    const terminal: ActiveTerminal = {
      workspacePath,
      info: {
        id,
        title,
        shell,
        cwd,
        status: "running",
        pid: child.pid,
        cursor: 0,
      },
      process: child,
      customTitle,
      titleBuffer: "",
      output: "",
      bufferCursor: 0,
      subscribers: new Map(),
      listeners: [],
    }
    this.terminals.set(id, terminal)
    terminal.listeners.push(
      child.onData(data => this.handleData(terminal, data)),
      child.onExit(({ exitCode }) => this.handleExit(terminal, exitCode)),
    )
    this.publish(terminal, "terminal.created")
    return { ...terminal.info }
  }

  update(workspacePath: string, id: string, params: TerminalUpdateParams): TerminalInfo {
    const terminal = this.require(workspacePath, id)
    let changed = false
    if (params.title !== undefined) {
      const title = params.title.trim()
      if (!title) throw Object.assign(new Error("params.title must not be empty"), { code: "INVALID_REQUEST" })
      if (title !== terminal.info.title) {
        changed = true
        terminal.info.title = title
        terminal.customTitle = title
        for (const subscriber of terminal.subscribers.values()) {
          if (!subscriber.active) {
            subscriber.pendingTitle = title
            continue
          }
          try {
            subscriber.onTitle(title)
          } catch {
            // A disconnected client must not affect the terminal process.
          }
        }
      }
    }
    if (params.rows !== undefined || params.cols !== undefined) {
      const size = terminalSize(params.rows ?? terminal.process.rows, params.cols ?? terminal.process.cols)
      // 尺寸没变就不动 pty 也不广播——客户端每次连接都会发一次 resize，
      // 无条件 publish 会触发 "updated → 重新拉列表 → 重连 → 再 resize" 的循环
      if (size.cols !== terminal.process.cols || size.rows !== terminal.process.rows) {
        changed = true
        if (terminal.info.status === "running") terminal.process.resize(size.cols, size.rows)
      }
    }
    if (changed) this.publish(terminal, "terminal.updated")
    return { ...terminal.info }
  }

  remove(workspacePath: string, id: string): void {
    const terminal = this.require(workspacePath, id)
    this.removeTerminal(terminal)
  }

  issueConnectToken(workspacePath: string, id: string): { token: string; expiresIn: number } {
    const terminal = this.require(workspacePath, id)
    const token = randomUUID()
    this.tickets.set(token, { terminalId: id, workspacePath: terminal.workspacePath, expiresAt: Date.now() + TICKET_TTL_MS })
    return { token, expiresIn: TICKET_TTL_MS / 1000 }
  }

  consumeConnectToken(id: string, token: string): string | undefined {
    const record = this.tickets.get(token)
    if (!record) return undefined
    this.tickets.delete(token)
    if (record.expiresAt < Date.now() || record.terminalId !== id) return undefined
    const terminal = this.terminals.get(id)
    if (!terminal) return undefined
    return terminal.workspacePath
  }

  write(workspacePath: string, id: string, data: string): void {
    const terminal = this.require(workspacePath, id)
    if (terminal.info.status !== "running") {
      throw Object.assign(new Error("terminal has exited"), { code: "TERMINAL_EXITED" })
    }
    terminal.process.write(data)
  }

  attach(
    workspacePath: string,
    id: string,
    cursor: number | undefined,
    onData: (data: string) => void,
    onEnd: (event: { exitCode: number | null }) => void,
    onTitle: (title: string) => void = () => {},
  ): TerminalAttachment {
    const terminal = this.require(workspacePath, id)
    const end = terminal.info.cursor
    const from = cursor === -1 ? end : cursor ?? terminal.bufferCursor
    if (!Number.isSafeInteger(from) || from < 0) {
      throw Object.assign(new Error("terminal cursor must be a non-negative integer or -1"), { code: "INVALID_REQUEST" })
    }
    if (from > end) {
      throw Object.assign(new Error("terminal cursor is in the future"), { code: "INVALID_REQUEST" })
    }
    if (from < terminal.bufferCursor) {
      throw Object.assign(new Error("terminal output cursor has expired"), { code: "TERMINAL_CURSOR_EXPIRED" })
    }
    const offset = Math.max(0, from - terminal.bufferCursor)
    const replay = offset >= terminal.output.length ? "" : terminal.output.slice(offset)

    // An exited terminal is a retained replay window: attach, deliver what is
    // still buffered, then report the exit. There is no live process to write to.
    if (terminal.info.status !== "running") {
      const exitCode = terminal.info.exitCode ?? null
      return {
        replay,
        replayCursor: from,
        cursor: end,
        activate: () => {
          try {
            onEnd({ exitCode })
          } catch {
            // A detached client must not prevent the socket from closing.
          }
        },
        detach: () => {},
      }
    }

    const subscriber: Subscriber = { active: false, pending: [], onData, onEnd, onTitle }
    const token = {}
    terminal.subscribers.set(token, subscriber)

    return {
      replay,
      replayCursor: from,
      cursor: end,
      activate: () => {
        if (subscriber.active) return
        subscriber.active = true
        try {
          for (const chunk of subscriber.pending) subscriber.onData(chunk)
        } catch {
          terminal.subscribers.delete(token)
        }
        subscriber.pending.length = 0
        if (subscriber.end) {
          try {
            subscriber.onEnd(subscriber.end)
          } catch {
            // A detached client must not affect the terminal process.
          }
        }
        if (subscriber.pendingTitle) {
          try {
            subscriber.onTitle(subscriber.pendingTitle)
          } catch {
            // A detached client must not affect the terminal process.
          }
          subscriber.pendingTitle = undefined
        }
      },
      detach: () => {
        terminal.subscribers.delete(token)
        subscriber.pending.length = 0
        subscriber.end = undefined
      },
    }
  }

  dispose(): void {
    for (const terminal of Array.from(this.terminals.values())) this.removeTerminal(terminal, false)
    this.terminals.clear()
    this.exitedOrder.length = 0
    this.tickets.clear()
    const stale = this.staleProcesses.splice(0)
    for (const process of stale) {
      try {
        process.kill()
      } catch {
        // The process is already gone; nothing left to reap.
      }
    }
  }

  /**
   * Kills every terminal owned by the workspace and invalidates their connect
   * tickets. Idempotent, so closing an already-closed workspace is a no-op.
   */
  closeWorkspace(workspacePath: string): void {
    const key = workspacePathKey(workspacePath)
    for (const terminal of Array.from(this.terminals.values())) {
      if (workspacePathKey(terminal.workspacePath) === key) this.removeTerminal(terminal)
    }
    for (const [token, record] of this.tickets) {
      if (workspacePathKey(record.workspacePath) === key) this.tickets.delete(token)
    }
  }

  private require(workspacePath: string, id: string): ActiveTerminal {
    const terminal = this.terminals.get(id)
    if (!terminal || workspacePathKey(terminal.workspacePath) !== workspacePathKey(workspacePath)) {
      throw Object.assign(new Error(`terminal not found: ${id}`), { code: "TERMINAL_NOT_FOUND" })
    }
    return terminal
  }

  private async resolveCwd(workspacePath: string, requested?: string): Promise<string> {
    const resolved = resolveWorkspacePath(workspacePath, requested ?? "")
    if (!resolved.exists) throw Object.assign(new Error("terminal cwd does not exist"), { code: "INVALID_REQUEST" })
    const stat = await lstat(resolved.absolute)
    if (!stat.isDirectory()) throw Object.assign(new Error("terminal cwd must be a directory"), { code: "INVALID_REQUEST" })
    return resolved.absolute
  }

  private handleData(terminal: ActiveTerminal, data: string): void {
    terminal.titleBuffer = `${terminal.titleBuffer}${data}`.slice(-512)
    const title = terminal.customTitle ? undefined : extractTerminalTitle(terminal.titleBuffer)
    if (title) terminal.titleBuffer = ""
    if (title) {
      terminal.info.title = title
      for (const subscriber of terminal.subscribers.values()) {
        if (subscriber.active) {
          try {
            subscriber.onTitle(title)
          } catch {
            // A disconnected client must not affect the terminal process.
          }
        } else {
          subscriber.pendingTitle = title
        }
      }
      this.publish(terminal, "terminal.updated")
    }
    terminal.info.cursor += data.length
    for (const [token, subscriber] of terminal.subscribers) {
      if (!subscriber.active) {
        subscriber.pending.push(data)
        continue
      }
      try {
        subscriber.onData(data)
      } catch {
        terminal.subscribers.delete(token)
      }
    }
    terminal.output += data
    if (terminal.output.length > OUTPUT_BUFFER_LIMIT) {
      const excess = terminal.output.length - OUTPUT_BUFFER_LIMIT
      terminal.output = terminal.output.slice(excess)
      terminal.bufferCursor += excess
    }
  }

  private handleExit(terminal: ActiveTerminal, exitCode: number): void {
    if (terminal.info.status === "exited") return
    terminal.info.status = "exited"
    terminal.info.exitCode = exitCode
    const end = { exitCode }
    for (const subscriber of terminal.subscribers.values()) {
      if (!subscriber.active) subscriber.end = end
      else {
        try {
          subscriber.onEnd(end)
        } catch {
          // A disconnected client must not prevent other subscribers from closing.
        }
      }
    }
    terminal.subscribers.clear()
    this.exitedOrder.push(terminal.info.id)
    this.publish(terminal, "terminal.exited")
    while (this.exitedOrder.length > EXITED_SESSION_LIMIT) {
      const oldest = this.exitedOrder.shift()
      const expired = oldest ? this.terminals.get(oldest) : undefined
      if (expired) this.removeTerminal(expired)
    }
  }

  private removeTerminal(terminal: ActiveTerminal, publish = true): void {
    this.terminals.delete(terminal.info.id)
    const index = this.exitedOrder.indexOf(terminal.info.id)
    if (index >= 0) this.exitedOrder.splice(index, 1)
    this.invalidateTerminalTickets(terminal.info.id)
    for (const listener of terminal.listeners) listener.dispose()
    terminal.listeners.length = 0
    try {
      terminal.process.kill()
    } catch {
      // Keep the handle so dispose can retry instead of losing the process.
      this.staleProcesses.push(terminal.process)
    }
    for (const subscriber of terminal.subscribers.values()) {
      if (subscriber.active) {
        try {
          subscriber.onEnd({ exitCode: terminal.info.exitCode ?? null })
        } catch {
          // Cleanup continues even when a client callback fails.
        }
      }
    }
    terminal.subscribers.clear()
    if (publish) this.publish(terminal, "terminal.deleted")
  }

  private invalidateTerminalTickets(id: string): void {
    for (const [token, record] of this.tickets) {
      if (record.terminalId === id) this.tickets.delete(token)
    }
  }

  private publish(terminal: ActiveTerminal, channel: TerminalEventChannel): void {
    this.options.publish?.(terminal.workspacePath, channel, { ...terminal.info })
  }
}

function resolveShell(requested?: string): string {
  if (requested?.trim()) return requested.trim()
  if (process.platform === "win32") return process.env.ComSpec || "cmd.exe"
  return process.env.SHELL || "/bin/sh"
}

function shellArgs(shell: string): string[] {
  const name = path.basename(shell).toLowerCase()
  if (name === "cmd" || name === "cmd.exe") return ["/d"]
  if (name === "powershell" || name === "powershell.exe" || name === "pwsh" || name === "pwsh.exe") {
    return ["-NoLogo", "-NoProfile"]
  }
  return ["-i"]
}

function terminalSize(rows?: number, cols?: number): { rows: number; cols: number } {
  const valid = (value: number | undefined, fallback: number) => {
    if (value === undefined) return fallback
    if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
      throw Object.assign(new Error("terminal size must be an integer from 1 to 500"), { code: "INVALID_REQUEST" })
    }
    return value
  }
  return { rows: valid(rows, 24), cols: valid(cols, 80) }
}

export function extractTerminalTitle(data: string): string | undefined {
  const match = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(data)
  const title = match?.[1]?.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  return title ? title.slice(0, 120) : undefined
}
