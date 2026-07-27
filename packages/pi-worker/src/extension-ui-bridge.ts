import { randomUUID } from "node:crypto"
import type {
  ExtensionUiDialogRequestV1,
  ExtensionUiDialogResponseV1,
  ExtensionUiEditorCommandV1,
  ExtensionUiStatePatchV1,
  ExtensionUiSettlementReasonV1,
} from "@piui/protocol"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"

const MAX_TEXT_LENGTH = 256 * 1024
const MAX_TITLE_LENGTH = 4 * 1024
const MAX_OPTIONS = 200
const MAX_WIDGET_LINES = 500

export type PiExtensionUiEvent =
  | { type: "requested"; request: ExtensionUiDialogRequestV1 }
  | { type: "settled"; requestId: string; sessionId: string; reason: ExtensionUiSettlementReasonV1 }
  | { type: "state"; sessionId: string; patch: ExtensionUiStatePatchV1 }
  | { type: "notify"; sessionId: string; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "editor"; sessionId: string; command: ExtensionUiEditorCommandV1 }

interface PendingDialog {
  request: ExtensionUiDialogRequestV1
  resolve: (response: ExtensionUiDialogResponseV1) => void
  timer?: NodeJS.Timeout
  removeAbort?: () => void
}

export class ExtensionUiBridge {
  private readonly pending = new Map<string, PendingDialog>()
  private readonly listeners = new Set<(event: PiExtensionUiEvent) => void>()
  private editorText = ""
  private toolsExpanded = false

  constructor(
    private readonly getSessionId: () => string,
    private readonly getWorkerGeneration: () => string | undefined,
  ) {}

  readonly context = this.createContext()

  onEvent(listener: (event: PiExtensionUiEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  respond(requestId: string, response: ExtensionUiDialogResponseV1): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    if (!("cancelled" in response)) {
      if (pending.request.kind === "confirm" && !("confirmed" in response)) return false
      if (pending.request.kind !== "confirm" && !("value" in response)) return false
      if (pending.request.kind === "select" && "value" in response &&
        !pending.request.options.includes(response.value)) return false
    }
    this.pending.delete(requestId)
    if (pending.timer) clearTimeout(pending.timer)
    pending.removeAbort?.()
    this.emit({
      type: "settled",
      requestId,
      sessionId: pending.request.sessionId,
      reason: "cancelled" in response ? "user_cancelled" : "submitted",
    })
    pending.resolve(response)
    return true
  }

  setEditorState(text: string): void {
    this.editorText = text
  }

  cancelAll(reason: ExtensionUiSettlementReasonV1): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.removeAbort?.()
      pending.resolve({ cancelled: true })
      this.emit({ type: "settled", requestId, sessionId: pending.request.sessionId, reason })
    }
    this.pending.clear()
  }

  private createContext(): ExtensionUIContext {
    const bridge = this
    return {
      select(title, options, opts) {
        return bridge.dialog("select", { title, options }, opts).then(response =>
          "value" in response && options.includes(response.value) ? response.value : undefined,
        )
      },
      confirm(title, message, opts) {
        return bridge.dialog("confirm", { title, message }, opts).then(response =>
          "confirmed" in response ? response.confirmed : false,
        )
      },
      input(title, placeholder, opts) {
        return bridge.dialog("input", { title, placeholder }, opts).then(response =>
          "value" in response ? response.value : undefined,
        )
      },
      editor(title, prefill) {
        return bridge.dialog("editor", { title, prefill }).then(response =>
          "value" in response ? response.value : undefined,
        )
      },
      notify(message, notifyType) {
        assertText("notification", message)
        bridge.emit({ type: "notify", sessionId: bridge.getSessionId(), message, notifyType })
      },
      onTerminalInput() {
        throw unsupported("terminal input")
      },
      setStatus(key, text) {
        assertText("status key", key, MAX_TITLE_LENGTH)
        if (text !== undefined) assertText("status", text)
        bridge.state({ kind: "status", key, text })
      },
      setWorkingMessage(message) {
        if (message !== undefined) assertText("working message", message)
        bridge.state({ kind: "workingMessage", message })
      },
      setWorkingVisible(visible) {
        bridge.state({ kind: "workingVisible", visible })
      },
      setWorkingIndicator(options) {
        if (options?.frames) assertStringArray("working indicator frames", options.frames, MAX_WIDGET_LINES)
        bridge.state({ kind: "workingIndicator", frames: options?.frames, intervalMs: options?.intervalMs })
      },
      setHiddenThinkingLabel(label) {
        if (label !== undefined) assertText("thinking label", label, MAX_TITLE_LENGTH)
        bridge.state({ kind: "hiddenThinkingLabel", label })
      },
      setWidget(key, content, options) {
        if (content !== undefined && !Array.isArray(content)) throw unsupported("component widgets")
        assertText("widget key", key, MAX_TITLE_LENGTH)
        if (content) assertStringArray("widget lines", content, MAX_WIDGET_LINES)
        bridge.state({
          kind: "widget",
          key,
          lines: content as string[] | undefined,
          placement: options?.placement,
        })
      },
      setFooter() {
        throw unsupported("custom footer")
      },
      setHeader() {
        throw unsupported("custom header")
      },
      setTitle(title) {
        assertText("title", title, MAX_TITLE_LENGTH)
        bridge.state({ kind: "title", title })
      },
      async custom() {
        throw unsupported("custom components")
      },
      pasteToEditor(text) {
        assertText("editor text", text)
        if (bridge.editorText.length + text.length > MAX_TEXT_LENGTH) {
          throw Object.assign(new Error("editor text exceeds the PiUI RPC limit"), { code: "EXTENSION_UI_LIMIT" })
        }
        bridge.editorText += text
        bridge.emit({ type: "editor", sessionId: bridge.getSessionId(), command: { kind: "paste", text } })
      },
      setEditorText(text) {
        assertText("editor text", text)
        bridge.editorText = text
        bridge.emit({ type: "editor", sessionId: bridge.getSessionId(), command: { kind: "set", text } })
      },
      getEditorText() {
        return bridge.editorText
      },
      addAutocompleteProvider() {
        throw unsupported("autocomplete providers")
      },
      setEditorComponent() {
        throw unsupported("custom editor components")
      },
      getEditorComponent() {
        throw unsupported("custom editor components")
      },
      get theme(): never {
        throw unsupported("TUI theme access")
      },
      getAllThemes() {
        throw unsupported("TUI theme enumeration")
      },
      getTheme() {
        throw unsupported("TUI theme access")
      },
      setTheme(name) {
        if (typeof name !== "string" || !name.trim()) return { success: false, error: "Theme name is required" }
        bridge.state({ kind: "theme", name: name.trim() })
        return { success: true }
      },
      getToolsExpanded() {
        return bridge.toolsExpanded
      },
      setToolsExpanded(expanded) {
        bridge.toolsExpanded = expanded
        bridge.state({ kind: "toolsExpanded", expanded })
      },
    }
  }

  private dialog(
    kind: ExtensionUiDialogRequestV1["kind"],
    fields: {
      title: string
      options?: string[]
      message?: string
      placeholder?: string
      prefill?: string
    },
    opts?: { timeout?: number; signal?: AbortSignal },
  ): Promise<ExtensionUiDialogResponseV1> {
    if (opts?.signal?.aborted) return Promise.resolve({ cancelled: true })
    assertText("dialog title", fields.title, MAX_TITLE_LENGTH)
    if (fields.message !== undefined) assertText("dialog message", fields.message)
    if (fields.placeholder !== undefined) assertText("dialog placeholder", fields.placeholder, MAX_TITLE_LENGTH)
    if (fields.prefill !== undefined) assertText("dialog prefill", fields.prefill)
    if (fields.options !== undefined) assertStringArray("dialog options", fields.options, MAX_OPTIONS)
    if (this.pending.size >= 32) {
      return Promise.reject(Object.assign(new Error("Too many pending extension UI dialogs"), {
        code: "EXTENSION_UI_LIMIT",
      }))
    }
    const requestId = randomUUID()
    const createdAt = new Date()
    const base = {
      requestId,
      sessionId: this.getSessionId(),
      workerGeneration: this.getWorkerGeneration(),
      title: fields.title,
      createdAt: createdAt.toISOString(),
      expiresAt: opts?.timeout ? new Date(createdAt.getTime() + opts.timeout).toISOString() : undefined,
    }
    const request: ExtensionUiDialogRequestV1 = kind === "select"
      ? { ...base, kind, options: fields.options ?? [] }
      : kind === "confirm"
        ? { ...base, kind, message: fields.message ?? "" }
        : kind === "input"
          ? { ...base, kind, placeholder: fields.placeholder }
          : { ...base, kind, prefill: fields.prefill }
    return new Promise(resolve => {
      const pending: PendingDialog = { request, resolve }
      const cancel = (reason: string) => {
        if (!this.pending.delete(requestId)) return
        if (pending.timer) clearTimeout(pending.timer)
        pending.removeAbort?.()
        resolve({ cancelled: true })
        this.emit({
          type: "settled",
          requestId,
          sessionId: request.sessionId,
          reason: reason as ExtensionUiSettlementReasonV1,
        })
      }
      if (opts?.timeout) pending.timer = setTimeout(() => cancel("timeout"), opts.timeout)
      if (opts?.signal) {
        const onAbort = () => cancel("aborted")
        opts.signal.addEventListener("abort", onAbort, { once: true })
        pending.removeAbort = () => opts.signal?.removeEventListener("abort", onAbort)
      }
      this.pending.set(requestId, pending)
      if (!this.emit({ type: "requested", request })) cancel("host_unavailable")
    })
  }

  private state(patch: ExtensionUiStatePatchV1): void {
    this.emit({ type: "state", sessionId: this.getSessionId(), patch })
  }

  private emit(event: PiExtensionUiEvent): boolean {
    let delivered = false
    for (const listener of this.listeners) {
      try {
        listener(event)
        delivered = true
      } catch {
        /* one failed transport must not prevent another listener from receiving the event */
      }
    }
    return delivered
  }
}

function unsupported(feature: string): Error {
  return Object.assign(new Error(`${feature} are unavailable in the PiUI RPC host`), {
    code: "EXTENSION_UI_TUI_ONLY",
  })
}

function assertText(name: string, value: unknown, maxLength = MAX_TEXT_LENGTH): asserts value is string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw Object.assign(new Error(`${name} must be a string no longer than ${maxLength} characters`), {
      code: "EXTENSION_UI_LIMIT",
    })
  }
}

function assertStringArray(name: string, value: unknown, maxItems: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== "string")) {
    throw Object.assign(new Error(`${name} must contain at most ${maxItems} strings`), {
      code: "EXTENSION_UI_LIMIT",
    })
  }
  for (const item of value) assertText(name, item)
}
