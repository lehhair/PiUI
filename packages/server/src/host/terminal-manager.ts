import { randomUUID } from "node:crypto"
import path from "node:path"
import { lstat } from "node:fs/promises"
import { spawn, type IPty } from "@lydell/node-pty"
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
    if (this.terminals.size >= TERMINAL_LIMIT) {
      throw Object.assign(new Error("terminal limit reached"), { code: "TERMINAL_LIMIT_REACHED" })
    }
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
      child = spawn(shell, shellArgs(shell), {
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
    if (params.title !== undefined) {
      const title = params.title.trim()
      if (!title) throw Object.assign(new Error("params.title must not be empty"), { code: "INVALID_REQUEST" })
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
    if (params.rows !== undefined || params.cols !== undefined) {
      const size = terminalSize(params.rows ?? terminal.process.rows, params.cols ?? terminal.process.cols)
      if (terminal.info.status === "running") terminal.process.resize(size.cols, size.rows)
    }
    this.publish(terminal, "terminal.updated")
    return { ...terminal.info }
  }

  remove(workspacePath: string, id: string): void {
    const terminal = this.require(workspacePath, id)
    this.removeTerminal(terminal)
  }

  issueConnectToken(workspacePath: string, id: string): { token: string; expiresIn: number } {
    const terminal = this.require(workspacePath, id)
    if (terminal.info.status !== "running") {
      throw Object.assign(new Error("terminal has exited"), { code: "TERMINAL_EXITED" })
    }
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
    if (!terminal || terminal.info.status !== "running") return undefined
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
    if (terminal.info.status !== "running") {
      throw Object.assign(new Error("terminal has exited"), { code: "TERMINAL_EXITED" })
    }
    const subscriber: Subscriber = { active: false, pending: [], onData, onEnd, onTitle }
    const token = {}
    terminal.subscribers.set(token, subscriber)
    const end = terminal.info.cursor
    const from = cursor === -1 ? end : cursor ?? terminal.bufferCursor
    if (!Number.isSafeInteger(from) || from < 0) {
      terminal.subscribers.delete(token)
      throw Object.assign(new Error("terminal cursor must be a non-negative integer or -1"), { code: "INVALID_REQUEST" })
    }
    if (from < terminal.bufferCursor) {
      terminal.subscribers.delete(token)
      throw Object.assign(new Error("terminal output cursor has expired"), { code: "TERMINAL_CURSOR_EXPIRED" })
    }
    const offset = Math.max(0, from - terminal.bufferCursor)
    const replay = offset >= terminal.output.length ? "" : terminal.output.slice(offset)

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
    for (const listener of terminal.listeners) listener.dispose()
    terminal.listeners.length = 0
    try {
      terminal.process.kill()
    } catch {
      // The process may have exited before the native PTY handle was released.
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
