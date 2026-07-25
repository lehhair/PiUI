import type { EventCursorV1, EventEnvelopeV1 } from "@piui/protocol"
import { randomUUID } from "node:crypto"

type Listener = (event: EventEnvelopeV1) => void

export class EventHub {
  private readonly listeners = new Set<Listener>()
  private readonly history: EventEnvelopeV1[] = []
  private epoch = randomUUID()
  private sequence = 0

  constructor(private readonly historyLimit = 1000) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(partial: {
    type: string
    sessionId?: string
    workspaceId?: string
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

  resetEpoch() {
    this.epoch = randomUUID()
    this.sequence = 0
    this.history.length = 0
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
