import { randomUUID } from "node:crypto"
import {
  eventStreamKey,
  PROTOCOL_VERSION,
  type EventChannel,
  type EventCursor,
  type EventCursorMap,
  type EventEnvelope,
  type EventResyncReason,
  type EventStreamRef,
  type JsonValue,
} from "@piui/protocol"

type Listener = (event: EventEnvelope) => void

interface StreamState {
  stream: EventStreamRef
  epoch: string
  sequence: number
  history: EventEnvelope[]
}

export class EventHub {
  private readonly listeners = new Set<Listener>()
  private readonly streams = new Map<string, StreamState>()

  constructor(private readonly historyLimit = 256) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(stream: EventStreamRef, channel: EventChannel, payload: JsonValue): EventEnvelope {
    const state = this.getOrCreate(stream)
    state.sequence += 1
    const event: EventEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      stream,
      cursor: { epoch: state.epoch, sequence: state.sequence },
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      channel,
      payload,
    }
    state.history.push(event)
    if (state.history.length > this.historyLimit) {
      state.history.splice(0, state.history.length - this.historyLimit)
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* a failed subscriber must not break the others */
      }
    }
    return event
  }

  getCursor(stream: EventStreamRef): EventCursor {
    const state = this.getOrCreate(stream)
    return { epoch: state.epoch, sequence: state.sequence }
  }

  getCursorMap(streams: EventStreamRef[]): EventCursorMap {
    return Object.fromEntries(streams.map(stream => [eventStreamKey(stream), this.getCursor(stream)]))
  }

  replaySince(
    stream: EventStreamRef,
    cursor?: EventCursor,
  ): { events: EventEnvelope[]; resyncRequired: boolean; reason?: EventResyncReason } {
    const state = this.getOrCreate(stream)
    if (!cursor) return { events: [], resyncRequired: true, reason: "missing_cursor" }
    if (cursor.epoch !== state.epoch) return { events: [], resyncRequired: true, reason: "epoch_mismatch" }
    if (cursor.sequence > state.sequence) return { events: [], resyncRequired: true, reason: "future_cursor" }
    const oldest = state.history[0]?.cursor.sequence ?? state.sequence + 1
    if (cursor.sequence < oldest - 1) return { events: [], resyncRequired: true, reason: "history_expired" }
    return {
      events: state.history.filter(event => event.cursor.sequence > cursor.sequence),
      resyncRequired: false,
    }
  }

  resetEpoch(stream: EventStreamRef): void {
    const state = this.getOrCreate(stream)
    state.epoch = randomUUID()
    state.sequence = 0
    state.history.length = 0
  }

  private getOrCreate(stream: EventStreamRef): StreamState {
    const key = eventStreamKey(stream)
    const existing = this.streams.get(key)
    if (existing) return existing
    const state: StreamState = { stream, epoch: randomUUID(), sequence: 0, history: [] }
    this.streams.set(key, state)
    return state
  }
}
