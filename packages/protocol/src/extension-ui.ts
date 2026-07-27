export type ExtensionUiDialogKindV1 = "select" | "confirm" | "input" | "editor"

interface ExtensionUiDialogRequestBaseV1 {
  requestId: string
  sessionId: string
  workerGeneration?: string
  title: string
  createdAt: string
  expiresAt?: string
}

export type ExtensionUiDialogRequestV1 =
  | (ExtensionUiDialogRequestBaseV1 & { kind: "select"; options: string[] })
  | (ExtensionUiDialogRequestBaseV1 & { kind: "confirm"; message: string })
  | (ExtensionUiDialogRequestBaseV1 & { kind: "input"; placeholder?: string })
  | (ExtensionUiDialogRequestBaseV1 & { kind: "editor"; prefill?: string })

export type ExtensionUiDialogResponseV1 =
  | { responseId?: string; value: string }
  | { responseId?: string; confirmed: boolean }
  | { responseId?: string; cancelled: true }

export type ExtensionUiSettlementReasonV1 =
  | "submitted"
  | "user_cancelled"
  | "timeout"
  | "aborted"
  | "session_replaced"
  | "runtime_reloaded"
  | "runtime_disposed"
  | "runtime_crashed"
  | "host_unavailable"

export type ExtensionUiStatePatchV1 =
  | { kind: "status"; key: string; text?: string }
  | { kind: "workingMessage"; message?: string }
  | { kind: "workingVisible"; visible: boolean }
  | { kind: "workingIndicator"; frames?: string[]; intervalMs?: number }
  | { kind: "hiddenThinkingLabel"; label?: string }
  | { kind: "widget"; key: string; lines?: string[]; placement?: "aboveEditor" | "belowEditor" }
  | { kind: "title"; title: string }
  | { kind: "theme"; name?: string }
  | { kind: "toolsExpanded"; expanded: boolean }

export type ExtensionUiEditorCommandV1 =
  | { kind: "set"; text: string }
  | { kind: "paste"; text: string }

export interface ExtensionUiStateV1 {
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

export interface ExtensionUiSnapshotV1 {
  sessionId: string
  workerGeneration?: string
  state: ExtensionUiStateV1
  pending: ExtensionUiDialogRequestV1[]
}

export type ExtensionUiMethodSupportV1 = "rpc" | "web-equivalent" | "tui-only"

export interface ExtensionUiMethodCapabilityV1 {
  support: ExtensionUiMethodSupportV1
  reason?: string
}
