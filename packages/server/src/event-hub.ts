import type { EventEnvelopeV1 } from "@piui/protocol"
import { randomUUID } from "node:crypto"

type Listener = (event: EventEnvelopeV1) => void

export class EventHub {
  private readonly listeners = new Set<Listener>()
  private epoch = randomUUID()
  private sequence = 0

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
    return event
  }

  resetEpoch() {
    this.epoch = randomUUID()
    this.sequence = 0
  }
}

export const eventHub = new EventHub()
