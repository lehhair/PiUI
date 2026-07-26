export interface EventEnvelopeV1<T = unknown> {
  protocolVersion: 1
  epoch: string
  sequence: number
  eventId: string
  sessionId?: string
  workspacePath?: string
  timestamp: string
  type: string
  payload: T
}

export interface EventCursorV1 {
  epoch: string
  sequence: number
}
