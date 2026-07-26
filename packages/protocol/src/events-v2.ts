import type { CommandStatusV2, CommandTypeV2 } from "./commands-v2.js"
import type { SessionSnapshotV1 } from "./session.js"
import type {
  ExtensionUiDialogRequestV1,
  ExtensionUiEditorCommandV1,
  ExtensionUiStatePatchV1,
  ExtensionUiStateV1,
} from "./extension-ui.js"
import type { PackageProgressV1, ProviderAuthEventV1 } from "./management.js"

export type EventStreamKindV2 = "server" | "workspace" | "session" | "provider" | "resources"
export type EventStreamKeyV2 =
  | "server"
  | `workspace:${string}`
  | `session:${string}`
  | `provider:${string}`
  | `resources:${string}`

export const EVENT_WS_SUBPROTOCOL_V2 = "piui.events.v2"

export interface EventStreamRefV2 {
  kind: EventStreamKindV2
  id: string
}

export interface EventCursorV2 {
  epoch: string
  sequence: number
}

export interface EventPayloadsV2 {
  "session.snapshot.updated": {
    sessionId: string
    reason: "command" | "runtime" | "resync"
    snapshot: SessionSnapshotV1
  }
  "session.timeline.delta": {
    sessionId: string
    epoch: string
    sequence: number
    items: SessionSnapshotV1["timeline"]
    removedItemIds?: string[]
    isStreaming: boolean
  }
  "session.runtime.replaced": { sessionId: string; workerGeneration: string }
  "session.runtime.crashed": { sessionId: string; workerGeneration?: string; message: string }
  "session.native.event": { sessionId: string; event: unknown }
  "workspace.sessions.updated": { workspacePath?: string; sessionId?: string }
  "command.updated": {
    commandId: string
    sessionId?: string
    status: CommandStatusV2
    error?: { code: string; message: string; retryable?: boolean }
    commandType?: CommandTypeV2
    inputText?: string
  }
  "extension.ui.requested": ExtensionUiDialogRequestV1
  "extension.ui.cancelled": { requestId: string; reason: string }
  "extension.ui.state.updated": { sessionId: string; patch: ExtensionUiStatePatchV1; state: ExtensionUiStateV1 }
  "extension.ui.notified": { sessionId: string; message: string; notifyType?: "info" | "warning" | "error" }
  "extension.ui.editor.command": { sessionId: string; command: ExtensionUiEditorCommandV1 }
  /** `sessionId` is set when the change came from a session-scoped runtime
   *  rather than the shared catalog. */
  "provider.auth.updated": { providerId: string; authenticated: boolean; sessionId?: string }
  "provider.auth.flow": ProviderAuthEventV1
  "resources.updated": { workspacePath?: string; revision: string }
  "packages.progress": PackageProgressV1
}

export type EventTypeV2 = keyof EventPayloadsV2

export interface EventEnvelopeV2<T extends EventTypeV2 = EventTypeV2> {
  protocolVersion: 2
  stream: EventStreamRefV2
  cursor: EventCursorV2
  eventId: string
  timestamp: string
  type: T
  payload: EventPayloadsV2[T]
}

export type AnyEventEnvelopeV2 = {
  [T in EventTypeV2]: EventEnvelopeV2<T>
}[EventTypeV2]

export type EventCursorMapV2 = Partial<Record<EventStreamKeyV2, EventCursorV2>>
export type EventResyncReasonV2 = "missing_cursor" | "epoch_mismatch" | "future_cursor" | "history_expired"

export interface EventSubscribeMessageV2 {
  type: "subscribe"
  protocolVersion: 2
  streams: EventStreamRefV2[]
  cursors: EventCursorMapV2
}

export type EventClientMessageV2 = EventSubscribeMessageV2 | { type: "ping"; protocolVersion: 2 }

export type EventServerMessageV2 =
  | {
      type: "hello"
      protocolVersion: 2
      service: "piui-server"
      subprotocol: typeof EVENT_WS_SUBPROTOCOL_V2
    }
  | { channel: "event"; event: AnyEventEnvelopeV2 }
  | {
      channel: "control"
      type: "resync_required"
      streams: Partial<
        Record<EventStreamKeyV2, { cursor: EventCursorV2; reason: EventResyncReasonV2 }>
      >
    }
  | { type: "pong"; protocolVersion: 2; t: number }

export function eventStreamKeyV2(stream: EventStreamRefV2): EventStreamKeyV2 {
  return stream.kind === "server" ? "server" : `${stream.kind}:${encodeURIComponent(stream.id)}`
}

export function parseEventStreamKeyV2(key: string): EventStreamRefV2 | null {
  if (key === "server") return { kind: "server", id: "server" }
  const separator = key.indexOf(":")
  if (separator <= 0) return null
  const kind = key.slice(0, separator)
  if (kind !== "workspace" && kind !== "session" && kind !== "provider" && kind !== "resources") return null
  try {
    const id = decodeURIComponent(key.slice(separator + 1))
    return id ? { kind, id } : null
  } catch {
    return null
  }
}
