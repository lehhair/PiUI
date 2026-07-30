import type { EventCursor, JsonObject, JsonValue, Problem } from "@piui/protocol"

export const PI_WORKER_PROTOCOL_VERSION = 3 as const
export const PI_WORKER_HEARTBEAT_INTERVAL_MS = 5_000

export interface WorkerHello {
  kind: "hello"
  workerProtocolVersion: number
  piSdkVersion: string
  piSdkVerified: boolean
  generation: string
  processId: number
  heartbeatIntervalMs: number
}

export interface WorkerCommandMessage {
  type: string
  params?: JsonObject
}

export interface WorkerRequest {
  kind: "request"
  id: string
  generation: string
  sessionId?: string
  command: WorkerCommandMessage
}

export type WorkerResponse =
  | { kind: "response"; id: string; generation: string; ok: true; data?: JsonValue }
  | { kind: "response"; id: string; generation: string; ok: false; error: Problem }

export type WorkerEvent =
  | {
      kind: "event"
      generation: string
      sessionId: string
      channel: "pi.event"
      event: JsonObject
      meta: EventCursor & { liveMessage?: JsonObject }
    }
  | { kind: "event"; generation: string; sessionId: string; channel: "session.head"; head: JsonObject }
  | { kind: "event"; generation: string; sessionId: string; channel: "session.activity"; event: JsonObject }
  | { kind: "event"; generation: string; sessionId: string; channel: "extension.ui"; event: JsonObject }
  | { kind: "event"; generation: string; sessionId: string; channel: "registry.updated"; event: JsonObject }
  | { kind: "event"; generation: string; channel: "provider.auth"; event: JsonObject }
  | { kind: "event"; generation: string; channel: "packages.progress"; event: JsonObject }
  | { kind: "event"; generation: string; channel: "resources.updated"; workspacePath?: string }

export type WorkerHostCall =
  | {
      type: "extensionReplacement.reserve"
      reservationId: string
      sourceSessionId: string
      operation: "new" | "fork" | "clone" | "switch" | "import"
      targetSessionFile?: string
    }
  | {
      type: "extensionReplacement.commit"
      reservationId: string
      replacement: JsonObject
    }
  | { type: "extensionReplacement.abort"; reservationId: string }
  | { type: "extensionShutdown"; sessionId: string }

export interface WorkerHostCallMessage {
  kind: "hostCall"
  id: string
  generation: string
  call: WorkerHostCall
}

export type WorkerHostReply =
  | { kind: "hostReply"; id: string; generation: string; ok: true }
  | { kind: "hostReply"; id: string; generation: string; ok: false; error: { code: string; message: string } }

export interface WorkerHeartbeat {
  kind: "heartbeat"
  generation: string
  timestamp: number
}

export type WorkerMessage = WorkerHello | WorkerResponse | WorkerEvent | WorkerHeartbeat | WorkerHostCallMessage
export type WorkerParentMessage = WorkerRequest | WorkerHostReply
