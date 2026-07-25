import {
  eventStreamKeyV2,
  type AnyEventEnvelopeV2,
  type EventCursorMapV2,
  type EventCursorV1,
  type EventCursorV2,
  type EventEnvelopeV1,
  type EventEnvelopeV2,
  type EventPayloadsV2,
  type EventResyncReasonV2,
  type EventStreamRefV2,
  type EventTypeV2,
  type SessionSnapshotV1,
  type CommandRecordV2,
} from "@piui/protocol"
import { randomUUID } from "node:crypto"

type Listener = (event: EventEnvelopeV1) => void
type ListenerV2 = (event: AnyEventEnvelopeV2) => void

interface EventStreamStateV2 {
  stream: EventStreamRefV2
  epoch: string
  sequence: number
  history: AnyEventEnvelopeV2[]
}

export class EventHub {
  private readonly listeners = new Set<Listener>()
  private readonly listenersV2 = new Set<ListenerV2>()
  private readonly history: EventEnvelopeV1[] = []
  private readonly streamsV2 = new Map<string, EventStreamStateV2>()
  private epoch = randomUUID()
  private sequence = 0

  constructor(
    private readonly historyLimit = 1000,
    private readonly historyLimitV2 = Math.min(historyLimit, 128),
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeV2(listener: ListenerV2): () => void {
    this.listenersV2.add(listener)
    return () => this.listenersV2.delete(listener)
  }

  publish(partial: {
    type: string
    sessionId?: string
    workspaceId?: string
    reason?: EventPayloadsV2["session.snapshot.updated"]["reason"]
    payload: unknown
  }): EventEnvelopeV1 {
    this.sequence += 1
    const event: EventEnvelopeV1 = {
      protocolVersion: 1,
      epoch: this.epoch,
      sequence: this.sequence,
      eventId: randomUUID(),
      sessionId: partial.sessionId,
      workspaceId: partial.workspaceId,
      timestamp: new Date().toISOString(),
      type: partial.type,
      payload: partial.payload,
    }
    for (const l of this.listeners) {
      try {
        l(event)
      } catch {
        /* ignore subscriber errors */
      }
    }
    this.history.push(event)
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit)
    this.publishLegacyAsV2(partial)
    return event
  }

  publishV2<T extends EventTypeV2>(
    stream: EventStreamRefV2,
    type: T,
    payload: EventPayloadsV2[T],
  ): EventEnvelopeV2<T> {
    const state = this.getOrCreateStreamV2(stream)
    state.sequence += 1
    const event: EventEnvelopeV2<T> = {
      protocolVersion: 2,
      stream,
      cursor: { epoch: state.epoch, sequence: state.sequence },
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      payload,
    }
    state.history.push(event as AnyEventEnvelopeV2)
    if (state.history.length > this.historyLimitV2) {
      state.history.splice(0, state.history.length - this.historyLimitV2)
    }
    for (const listener of this.listenersV2) {
      try {
        listener(event as AnyEventEnvelopeV2)
      } catch {
        /* ignore subscriber errors */
      }
    }
    return event
  }

  getCursor(): EventCursorV1 {
    return { epoch: this.epoch, sequence: this.sequence }
  }

  replaySince(cursor?: EventCursorV1): { events: EventEnvelopeV1[]; resyncRequired: boolean } {
    if (!cursor || cursor.epoch !== this.epoch || cursor.sequence > this.sequence) {
      return { events: [], resyncRequired: true }
    }
    const oldest = this.history[0]?.sequence ?? this.sequence + 1
    if (cursor.sequence < oldest - 1) return { events: [], resyncRequired: true }
    return { events: this.history.filter(event => event.sequence > cursor.sequence), resyncRequired: false }
  }

  getCursorV2(stream: EventStreamRefV2): EventCursorV2 {
    const state = this.getOrCreateStreamV2(stream)
    return { epoch: state.epoch, sequence: state.sequence }
  }

  getCursorMapV2(streams: EventStreamRefV2[]): EventCursorMapV2 {
    return Object.fromEntries(streams.map(stream => [eventStreamKeyV2(stream), this.getCursorV2(stream)]))
  }

  replaySinceV2(
    stream: EventStreamRefV2,
    cursor?: EventCursorV2,
  ): { events: AnyEventEnvelopeV2[]; resyncRequired: boolean; reason?: EventResyncReasonV2 } {
    const state = this.getOrCreateStreamV2(stream)
    if (!cursor) return { events: [], resyncRequired: true, reason: "missing_cursor" }
    if (cursor.epoch !== state.epoch) return { events: [], resyncRequired: true, reason: "epoch_mismatch" }
    if (cursor.sequence > state.sequence) return { events: [], resyncRequired: true, reason: "future_cursor" }
    const oldest = state.history[0]?.cursor.sequence ?? state.sequence + 1
    if (cursor.sequence < oldest - 1) {
      return { events: [], resyncRequired: true, reason: "history_expired" }
    }
    return {
      events: state.history.filter(event => event.cursor.sequence > cursor.sequence),
      resyncRequired: false,
    }
  }

  resetEpoch() {
    this.epoch = randomUUID()
    this.sequence = 0
    this.history.length = 0
  }

  resetEpochV2(stream: EventStreamRefV2): void {
    const state = this.getOrCreateStreamV2(stream)
    state.epoch = randomUUID()
    state.sequence = 0
    state.history.length = 0
  }

  private getOrCreateStreamV2(stream: EventStreamRefV2): EventStreamStateV2 {
    const key = eventStreamKeyV2(stream)
    const existing = this.streamsV2.get(key)
    if (existing) return existing
    const state: EventStreamStateV2 = { stream, epoch: randomUUID(), sequence: 0, history: [] }
    this.streamsV2.set(key, state)
    return state
  }

  private publishLegacyAsV2(partial: {
    type: string
    sessionId?: string
    workspaceId?: string
    reason?: EventPayloadsV2["session.snapshot.updated"]["reason"]
    payload: unknown
  }): void {
    if (partial.type === "session.snapshot" && partial.sessionId) {
      this.publishV2(
        { kind: "session", id: partial.sessionId },
        "session.snapshot.updated",
        {
          sessionId: partial.sessionId,
          reason: partial.reason ?? "runtime",
          snapshot: partial.payload as SessionSnapshotV1,
        },
      )
      return
    }
    if (partial.type === "command.updated") {
      const record = partial.payload as CommandRecordV2
      const payload: EventPayloadsV2["command.updated"] = {
        commandId: record.request.commandId,
        sessionId: record.request.sessionId,
        status: record.status,
      }
      this.publishV2(
        payload.sessionId ? { kind: "session", id: payload.sessionId } : { kind: "server", id: "server" },
        "command.updated",
        payload,
      )
      return
    }
    if (partial.type === "session.updated") {
      this.publishV2(
        partial.workspaceId
          ? { kind: "workspace", id: partial.workspaceId }
          : { kind: "server", id: "server" },
        "workspace.sessions.updated",
        { workspaceId: partial.workspaceId, sessionId: partial.sessionId },
      )
    }
  }
}

const serverHubs = new WeakMap<object, EventHub>()

export function bindEventHub(server: object, hub: EventHub): void {
  serverHubs.set(server, hub)
}

export function getBoundEventHub(server: object): EventHub {
  const hub = serverHubs.get(server)
  if (!hub) throw new Error("PiUI event hub is not bound to this server")
  return hub
}
