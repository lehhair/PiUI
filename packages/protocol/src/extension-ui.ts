export type ExtensionUiDialogKindV1 = "select" | "confirm" | "input" | "editor"

export interface ExtensionUiDialogRequestV1 {
  requestId: string
  sessionId: string
  workerGeneration?: string
  kind: ExtensionUiDialogKindV1
  title: string
  options?: string[]
  message?: string
  placeholder?: string
  prefill?: string
  createdAt: string
  expiresAt?: string
}

export type ExtensionUiDialogResponseV1 =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }

export type ExtensionUiStatePatchV1 =
  | { kind: "status"; key: string; text?: string }
  | { kind: "workingMessage"; message?: string }
  | { kind: "workingVisible"; visible: boolean }
  | { kind: "workingIndicator"; frames?: string[]; intervalMs?: number }
  | { kind: "hiddenThinkingLabel"; label?: string }
  | { kind: "widget"; key: string; lines?: string[]; placement?: "aboveEditor" | "belowEditor" }
  | { kind: "title"; title: string }

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
}

export interface ExtensionUiSnapshotV1 {
  sessionId: string
  state: ExtensionUiStateV1
  pending: ExtensionUiDialogRequestV1[]
}
