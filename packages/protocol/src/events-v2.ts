export type EventStreamKindV2 = "server" | "workspace" | "session" | "provider" | "resources"

export interface EventStreamRefV2 {
  kind: EventStreamKindV2
  id: string
}

export interface EventCursorV2 {
  epoch: string
  sequence: number
}

export interface EventPayloadsV2 {
  "session.snapshot.updated": { sessionId: string; reason: "command" | "runtime" | "resync" }
  "session.runtime.replaced": { sessionId: string; workerGeneration: string }
  "command.updated": { commandId: string; sessionId?: string; status: CommandStatusV2 }
  "extension.ui.requested": { requestId: string; sessionId: string; kind: string }
  "extension.ui.cancelled": { requestId: string; reason: string }
  "provider.auth.updated": { providerId: string; authenticated: boolean }
  "resources.updated": { workspaceId?: string; revision: string }
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

export type EventCursorMapV2 = Record<string, EventCursorV2>
import type { CommandStatusV2 } from "./commands-v2.js"
