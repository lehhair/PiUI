import { randomUUID } from "node:crypto"
import type {
  ExtensionUiDialogRequestV1,
  ExtensionUiDialogResponseV1,
  ExtensionUiEditorCommandV1,
  ExtensionUiStatePatchV1,
} from "@piui/protocol"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"

export type PiExtensionUiEvent =
  | { type: "requested"; request: ExtensionUiDialogRequestV1 }
  | { type: "cancelled"; requestId: string; reason: string }
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
    this.pending.delete(requestId)
    if (pending.timer) clearTimeout(pending.timer)
    pending.removeAbort?.()
    pending.resolve(response)
    return true
  }

  setEditorState(text: string): void {
    this.editorText = text
  }

  cancelAll(reason: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.removeAbort?.()
      pending.resolve({ cancelled: true })
      this.emit({ type: "cancelled", requestId, reason })
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
        bridge.emit({ type: "notify", sessionId: bridge.getSessionId(), message, notifyType })
      },
      onTerminalInput() {
        return () => {}
      },
      setStatus(key, text) {
        bridge.state({ kind: "status", key, text })
      },
      setWorkingMessage(message) {
        bridge.state({ kind: "workingMessage", message })
      },
      setWorkingVisible(visible) {
        bridge.state({ kind: "workingVisible", visible })
      },
      setWorkingIndicator(options) {
        bridge.state({ kind: "workingIndicator", frames: options?.frames, intervalMs: options?.intervalMs })
      },
      setHiddenThinkingLabel(label) {
        bridge.state({ kind: "hiddenThinkingLabel", label })
      },
      setWidget(key, content, options) {
        if (content !== undefined && !Array.isArray(content)) throw unsupported("component widgets")
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
        bridge.state({ kind: "title", title })
      },
      async custom() {
        throw unsupported("custom components")
      },
      pasteToEditor(text) {
        bridge.editorText += text
        bridge.emit({ type: "editor", sessionId: bridge.getSessionId(), command: { kind: "paste", text } })
      },
      setEditorText(text) {
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
        return undefined
      },
      get theme(): never {
        throw unsupported("TUI theme access")
      },
      getAllThemes() {
        return []
      },
      getTheme() {
        return undefined
      },
      setTheme() {
        return { success: false, error: "Theme switching is not supported by the PiUI RPC host" }
      },
      getToolsExpanded() {
        return false
      },
      setToolsExpanded() {
        throw unsupported("TUI tool expansion")
      },
    }
  }

  private dialog(
    kind: ExtensionUiDialogRequestV1["kind"],
    fields: Pick<ExtensionUiDialogRequestV1, "title" | "options" | "message" | "placeholder" | "prefill">,
    opts?: { timeout?: number; signal?: AbortSignal },
  ): Promise<ExtensionUiDialogResponseV1> {
    if (opts?.signal?.aborted) return Promise.resolve({ cancelled: true })
    const requestId = randomUUID()
    const createdAt = new Date()
    const request: ExtensionUiDialogRequestV1 = {
      requestId,
      sessionId: this.getSessionId(),
      workerGeneration: this.getWorkerGeneration(),
      kind,
      title: fields.title,
      options: fields.options,
      message: fields.message,
      placeholder: fields.placeholder,
      prefill: fields.prefill,
      createdAt: createdAt.toISOString(),
      expiresAt: opts?.timeout ? new Date(createdAt.getTime() + opts.timeout).toISOString() : undefined,
    }
    return new Promise(resolve => {
      const pending: PendingDialog = { request, resolve }
      const cancel = (reason: string) => {
        if (!this.pending.delete(requestId)) return
        if (pending.timer) clearTimeout(pending.timer)
        pending.removeAbort?.()
        resolve({ cancelled: true })
        this.emit({ type: "cancelled", requestId, reason })
      }
      if (opts?.timeout) pending.timer = setTimeout(() => cancel("timeout"), opts.timeout)
      if (opts?.signal) {
        const onAbort = () => cancel("aborted")
        opts.signal.addEventListener("abort", onAbort, { once: true })
        pending.removeAbort = () => opts.signal?.removeEventListener("abort", onAbort)
      }
      this.pending.set(requestId, pending)
      this.emit({ type: "requested", request })
    })
  }

  private state(patch: ExtensionUiStatePatchV1): void {
    this.emit({ type: "state", sessionId: this.getSessionId(), patch })
  }

  private emit(event: PiExtensionUiEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function unsupported(feature: string): Error {
  return Object.assign(new Error(`${feature} are unavailable in the PiUI RPC host`), {
    code: "EXTENSION_UI_UNSUPPORTED",
  })
}
