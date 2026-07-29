export type ExtensionUiDialogKind = "select" | "confirm" | "input" | "editor"

type ExtensionUiDialogRequestBase = {
  requestId: string
  sessionId: string
  workerGeneration?: string
  title: string
  createdAt: string
  expiresAt?: string
}

export type ExtensionUiDialogRequest =
  | (ExtensionUiDialogRequestBase & { kind: "select"; options: string[] })
  | (ExtensionUiDialogRequestBase & { kind: "confirm"; message: string })
  | (ExtensionUiDialogRequestBase & { kind: "input"; placeholder?: string })
  | (ExtensionUiDialogRequestBase & { kind: "editor"; prefill?: string })

export type ExtensionUiDialogResponse =
  | { responseId?: string; value: string }
  | { responseId?: string; confirmed: boolean }
  | { responseId?: string; cancelled: true }

export type ExtensionUiSettlementReason =
  | "submitted"
  | "user_cancelled"
  | "timeout"
  | "aborted"
  | "session_replaced"
  | "runtime_reloaded"
  | "runtime_disposed"
  | "runtime_crashed"
  | "host_unavailable"

export type ExtensionUiStatePatch =
  | { kind: "status"; key: string; text?: string }
  | { kind: "workingMessage"; message?: string }
  | { kind: "workingVisible"; visible: boolean }
  | { kind: "workingIndicator"; frames?: string[]; intervalMs?: number }
  | { kind: "hiddenThinkingLabel"; label?: string }
  | { kind: "widget"; key: string; lines?: string[]; placement?: "aboveEditor" | "belowEditor" }
  | { kind: "title"; title: string }
  | { kind: "theme"; name?: string }
  | { kind: "toolsExpanded"; expanded: boolean }

export type ExtensionUiEditorCommand =
  | { kind: "set"; text: string }
  | { kind: "paste"; text: string }

export type ExtensionUiState = {
  revision: number
  statuses: Record<string, string>
  workingMessage?: string
  workingVisible: boolean
  workingIndicator?: { frames: string[]; intervalMs?: number }
  hiddenThinkingLabel?: string
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>
  title?: string
  editorText: string
  themeName?: string
  toolsExpanded: boolean
}

export type ExtensionUiSnapshot = {
  sessionId: string
  workerGeneration?: string
  state: ExtensionUiState
  pending: ExtensionUiDialogRequest[]
}

export type ExtensionUiMethodSupport = "rpc" | "web-equivalent" | "tui-only"

export type ExtensionUiMethodCapability = {
  support: ExtensionUiMethodSupport
  reason?: string
}
