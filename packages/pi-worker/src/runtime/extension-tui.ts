import { Container, getKeybindings, TuiMainScreen, type Component, type Terminal } from "@earendil-works/pi-tui"
import type { KeybindingsManager as SdkKeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import type { ExtensionTuiAttach, ExtensionTuiKind } from "@piui/protocol"
import { getLoadedSdk } from "../sdk-host.js"

const DEFAULT_COLS = 64
const DEFAULT_ROWS = 10
const MAX_FRAME_BYTES = 256 * 1024

/**
 * Offscreen pi-tui `Terminal` implementation. Every write the TUI performs
 * (differential ANSI rendering) is captured and flushed as a single frame per
 * synchronous render pass, so the app can feed it straight into xterm.js.
 * Key input is routed back in via {@link input}.
 */
export class VirtualTerminal implements Terminal {
  private inputHandler?: (data: string) => void
  private resizeHandler?: () => void
  private buffer = ""
  private flushTimer?: ReturnType<typeof setTimeout>
  private _columns: number
  private _rows: number

  /** Fired once per render pass with the accumulated ANSI data. */
  onFrame?: (data: string) => void

  constructor(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    this._columns = cols
    this._rows = rows
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    this.resizeHandler = onResize
  }

  stop(): void {
    this.inputHandler = undefined
    this.resizeHandler = undefined
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    this.buffer = ""
  }

  drainInput(): Promise<void> {
    return Promise.resolve()
  }

  write(data: string): void {
    this.buffer += data
    if (this.flushTimer !== undefined) return
    // A synchronous render pass is a single JS turn; flushing on the next
    // macrotask delivers the complete pass as one frame.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      const frame = this.buffer
      this.buffer = ""
      if (frame && this.onFrame) {
        this.onFrame(frame.length > MAX_FRAME_BYTES ? frame.slice(0, MAX_FRAME_BYTES) : frame)
      }
    }, 0)
  }

  get columns(): number {
    return this._columns
  }

  get rows(): number {
    return this._rows
  }

  get kittyProtocolActive(): boolean {
    return false
  }

  moveBy(lines: number): void {
    this.write(lines > 0 ? `\x1b[${lines}B` : `\x1b[${-lines}A`)
  }

  hideCursor(): void {
    this.write("\x1b[?25l")
  }

  showCursor(): void {
    this.write("\x1b[?25h")
  }

  clearLine(): void {
    this.write("\x1b[2K")
  }

  clearFromCursor(): void {
    this.write("\x1b[0J")
  }

  clearScreen(): void {
    this.write("\x1b[2J\x1b[H")
  }

  setTitle(): void {
    /* ignore — the app title is managed by PiUI */
  }

  setProgress(): void {
    /* ignore */
  }

  resize(cols: number, rows: number): void {
    if (cols === this._columns && rows === this._rows) return
    this._columns = cols
    this._rows = rows
    this.resizeHandler?.()
  }

  /** Route raw key input from the app into the TUI. */
  input(data: string): void {
    this.inputHandler?.(data)
  }
}

export type ExtensionTuiHostEvent =
  | { type: "attach"; attach: ExtensionTuiAttach }
  | { type: "detach"; key: string }
  | { type: "frame"; data: string }

interface MountedPanel {
  key: string
  kind: ExtensionTuiKind
  component: Component & { dispose?: () => void }
  container: ContainerLike
}

interface ContainerLike {
  addChild(component: Component): void
  removeChild(component: Component): void
}

/**
 * Hosts pi-tui components (extension component widgets, custom() panels,
 * custom footer/header) offscreen for PiUI. One instance per Pi session:
 * header / widgets (above & below) / footer stack in a single `TuiMainScreen`
 * bound to a {@link VirtualTerminal}; `custom()` renders as an overlay on top.
 */
export class ExtensionTuiHost {
  private readonly terminal = new VirtualTerminal(DEFAULT_COLS, DEFAULT_ROWS)
  private readonly tui: TuiMainScreen
  // pi-coding-agent does not export its KeybindingsManager subclass at runtime
  // (type-only export), so the pi-tui singleton is used; the SDK type is a thin
  // subclass adding configPath/reload/getEffectiveConfig, which factories
  // rarely touch — the cast is a deliberate structural bridge.
  private readonly keybindings = getKeybindings() as unknown as SdkKeybindingsManager
  private readonly header = new Container()
  private readonly widgetsAbove = new Container()
  private readonly widgetsBelow = new Container()
  private readonly footer = new Container()
  private readonly mounts = new Map<string, MountedPanel>()
  private customHandle?: { hide(): void }
  private started = false

  constructor(private readonly emit: (event: ExtensionTuiHostEvent) => void) {
    this.tui = new TuiMainScreen(this.terminal, false)
    // Keep the same stacking order the interactive TUI uses.
    for (const container of [this.header, this.widgetsAbove, this.widgetsBelow, this.footer]) {
      this.tui.addChild(container)
    }
    this.terminal.onFrame = data => this.emit({ type: "frame", data })
  }

  getTheme(): Theme {
    // The pi-coding-agent package index does not re-export the singleton
    // `theme` (only the Theme class), so build a default dark palette. The
    // interactive TUI's components only use theme.fg/bg helpers, so a static
    // palette is sufficient for offscreen rendering.
    try {
      const sdk = getLoadedSdk().sdk
      return new sdk.Theme(DEFAULT_FG, DEFAULT_BG, "truecolor")
    } catch {
      // SDK not loaded yet (unit tests / early startup): fall back to a
      // structural ANSI theme so factories still receive a working object.
      return themeFallback as unknown as Theme
    }
  }

  getTui(): TuiMainScreen {
    return this.tui
  }

  getKeybindings(): SdkKeybindingsManager {
    return this.keybindings
  }

  mount(kind: ExtensionTuiKind, key: string, component: Component & { dispose?: () => void }, placement?: "aboveEditor" | "belowEditor"): void {
    this.unmount(key)
    const container = kind === "header" ? this.header
      : kind === "footer" ? this.footer
        : placement === "belowEditor" ? this.widgetsBelow : this.widgetsAbove
    container.addChild(component)
    this.mounts.set(key, { key, kind, component, container })
    this.ensureStarted()
    this.emit({
      type: "attach",
      attach: {
        key,
        kind,
        placement: kind === "widget" ? placement : undefined,
        width: this.terminal.columns,
        height: this.terminal.rows,
      },
    })
    this.tui.requestRender()
  }

  unmount(key: string): void {
    const mount = this.mounts.get(key)
    if (!mount) return
    mount.container.removeChild(mount.component)
    mount.component.dispose?.()
    this.mounts.delete(key)
    this.emit({ type: "detach", key })
    if (this.mounts.size === 0 && !this.customHandle) {
      this.stop()
    } else {
      this.tui.requestRender()
    }
  }

  /**
   * Mount a `custom()` component as an overlay. Returns a handle used by the
   * bridge to close it once the extension resolves its promise.
   */
  mountCustom(component: Component & { dispose?: () => void }): { hide(): void } {
    this.ensureStarted()
    if (this.customHandle) this.customHandle.hide()
    const overlay = this.tui.showOverlay(component, { width: "100%", maxHeight: "100%", anchor: "center" })
    const teardown = () => {
      if (!this.customHandle) return
      this.customHandle = undefined
      component.dispose?.()
      overlay.hide()
      this.tui.setFocus(null)
      this.emit({ type: "detach", key: "custom" })
      if (this.mounts.size === 0) this.stop()
      else this.tui.requestRender()
    }
    this.customHandle = { hide: teardown }
    this.tui.setFocus(component)
    this.tui.requestRender()
    this.emit({
      type: "attach",
      attach: { key: "custom", kind: "custom", width: this.terminal.columns, height: this.terminal.rows },
    })
    return { hide: teardown }
  }

  /** Close the active `custom()` overlay (no-op when none is mounted). */
  unmountCustom(): void {
    if (!this.customHandle) return
    this.customHandle.hide()
  }

  input(data: string): void {
    if (!this.started) return
    this.terminal.input(data)
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows)
  }

  redraw(): void {
    if (!this.started) return
    this.tui.renderNow(true)
  }

  hasAttachments(): boolean {
    return this.mounts.size > 0 || this.customHandle !== undefined
  }

  reset(): void {
    for (const key of [...this.mounts.keys()]) this.unmount(key)
    if (this.customHandle) this.customHandle.hide()
    this.stop()
  }

  private ensureStarted(): void {
    if (this.started) return
    this.tui.start()
    this.started = true
  }

  private stop(): void {
    if (!this.started) return
    this.started = false
    this.tui.stop()
    this.terminal.stop()
  }
}

const DEFAULT_FG = {  accent: "#4f9cff", border: "#3a3f4b", borderAccent: "#4f9cff", borderMuted: "#2c313c",
  success: "#3fb950", error: "#f85149", warning: "#d29922", muted: "#8b949e", dim: "#6e7681",
  text: "#e6edf3", thinkingText: "#8b949e", userMessageText: "#e6edf3", customMessageText: "#e6edf3",
  customMessageLabel: "#8b949e", toolTitle: "#e6edf3", toolOutput: "#c9d1d9",
  mdHeading: "#e6edf3", mdLink: "#58a6ff", mdLinkUrl: "#8b949e", mdCode: "#79c0ff",
  mdCodeBlock: "#c9d1d9", mdCodeBlockBorder: "#3a3f4b", mdQuote: "#8b949e", mdQuoteBorder: "#3a3f4b",
  mdHr: "#3a3f4b", mdListBullet: "#8b949e", toolDiffAdded: "#3fb950", toolDiffRemoved: "#f85149",
  toolDiffContext: "#c9d1d9", syntaxComment: "#8b949e", syntaxKeyword: "#ff7b72", syntaxFunction: "#d2a8ff",
  syntaxVariable: "#ffa657", syntaxString: "#a5d6ff", syntaxNumber: "#79c0ff", syntaxType: "#ffa657",
  syntaxOperator: "#ff7b72", syntaxPunctuation: "#c9d1d9", thinkingOff: "#8b949e", thinkingMinimal: "#8b949e",
  thinkingLow: "#8b949e", thinkingMedium: "#8b949e", thinkingHigh: "#8b949e", thinkingXhigh: "#8b949e",
  thinkingMax: "#8b949e", bashMode: "#3fb950",
} as const

const DEFAULT_BG = {
  selectedBg: "#1f6feb", scrollbarThumb: "#30363d", userMessageBg: "#1f6feb",
  customMessageBg: "#2d333b", toolPendingBg: "#2d333b", toolSuccessBg: "#238636",
  toolErrorBg: "#da3633",
} as const

/** Structural ANSI theme used when the SDK is not loaded yet. */
const themeFallback = {
  fg(_color: string, text: string): string {
    return text
  },
  bg(_color: string, text: string): string {
    return text
  },
  bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`
  },
  italic(text: string): string {
    return `\x1b[3m${text}\x1b[23m`
  },
  underline(text: string): string {
    return `\x1b[4m${text}\x1b[24m`
  },
  inverse(text: string): string {
    return `\x1b[7m${text}\x1b[27m`
  },
  strikethrough(text: string): string {
    return `\x1b[9m${text}\x1b[29m`
  },
  getFgAnsi(_color: string): string {
    return ""
  },
  getBgAnsi(_color: string): string {
    return ""
  },
}
