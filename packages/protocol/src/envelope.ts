import type { JsonObject, JsonValue } from "./json.js"
import type { Problem } from "./problem.js"
import { EVENT_WS_SUBPROTOCOL, PROTOCOL_VERSION } from "./version.js"

export type CommandEnvelope = {
  id: string
  type: string
  sessionId?: string
  params?: JsonObject
}

export type CommandStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown_after_crash"

export type CommandRecord = {
  id: string
  type: string
  sessionId?: string
  status: CommandStatus
  submittedAt: string
  startedAt?: string
  completedAt?: string
  result?: JsonValue
  error?: Problem
}

export type EventStreamKind = "server" | "workspace" | "session" | "provider" | "resources"

export type EventStreamRef = {
  kind: EventStreamKind
  id: string
}

export type EventCursor = {
  epoch: string
  sequence: number
}

export type EventChannel =
  | "pi.event"
  | "session.head"
  | "command.updated"
  | "extension.ui"
  | "provider.auth"
  | "packages.progress"
  | "registry.updated"
  | "workspace.files"
  | "workspace.git"
  | "sessions.updated"
  | "sessions.activity"
  | "resources.updated"

export type EventEnvelope = {
  protocolVersion: typeof PROTOCOL_VERSION
  stream: EventStreamRef
  cursor: EventCursor
  eventId: string
  timestamp: string
  channel: EventChannel
  payload: JsonValue
}

export type EventStreamKey =
  | "server"
  | `workspace:${string}`
  | `session:${string}`
  | `provider:${string}`
  | `resources:${string}`

export type EventCursorMap = Partial<Record<EventStreamKey, EventCursor>>

export type EventResyncReason = "missing_cursor" | "epoch_mismatch" | "future_cursor" | "history_expired"

export function eventStreamKey(stream: EventStreamRef): EventStreamKey {
  return stream.kind === "server" ? "server" : `${stream.kind}:${encodeURIComponent(stream.id)}`
}

export function parseEventStreamKey(key: string): EventStreamRef | null {
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

export type EventSubscribeMessage = {
  type: "subscribe"
  protocolVersion: typeof PROTOCOL_VERSION
  streams: EventStreamRef[]
  cursors: EventCursorMap
}

export type EventClientMessage = EventSubscribeMessage | { type: "ping"; protocolVersion: typeof PROTOCOL_VERSION }

export type EventServerMessage =
  | {
      type: "hello"
      protocolVersion: typeof PROTOCOL_VERSION
      service: "piui-server"
      subprotocol: typeof EVENT_WS_SUBPROTOCOL
    }
  | { channel: "event"; event: EventEnvelope }
  | {
      channel: "control"
      type: "resync_required"
      streams: Partial<Record<EventStreamKey, { cursor: EventCursor; reason: EventResyncReason }>>
    }
  | { channel: "control"; type: "problem"; problem: Problem }
  | { type: "pong"; protocolVersion: typeof PROTOCOL_VERSION; t: number }

export type CommandAcceptedResponse = {
  command: CommandRecord
}
