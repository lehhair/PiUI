import type { EventCursor } from "./envelope.js"
import type { JsonObject, JsonValue } from "./json.js"

export type SessionHead = {
  sdkVersion: string
  revision: number
  sessionFormatVersion?: number
  header: JsonObject | null
  leafId: string | null
  entryCount: number
  epoch: string
}

export type LiveMessage = {
  id: string
  revision: number
  phase: "streaming" | "persisting"
  message: JsonValue
}

export type BranchCheckpoint = {
  position: EventCursor
  liveMessage?: LiveMessage
}

export type EntriesPage = {
  head: SessionHead
  items: JsonObject[]
  checkpoint?: BranchCheckpoint
  beforeCursor?: string
  hasMore: boolean
}
