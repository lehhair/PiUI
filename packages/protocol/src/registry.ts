import type { JsonObject, JsonValue } from "./json.js"

export type ToolDescriptor = {
  name: string
  description?: string
  parameters?: JsonObject
  promptGuidelines?: string[]
  sourceInfo?: JsonValue
  [extra: string]: JsonValue | undefined
}

export type CommandDescriptor = {
  name: string
  description?: string
  sourceInfo?: JsonValue
  [extra: string]: JsonValue | undefined
}

export type ExtensionDescriptor = {
  path: string
  hidden?: boolean
  sourceInfo?: JsonValue
  tools: string[]
  commands: string[]
  handlers: string[]
}

export type RegistrySnapshot = {
  sdkVersion: string
  tools: ToolDescriptor[]
  activeTools: string[]
  commands: CommandDescriptor[]
  extensions: ExtensionDescriptor[]
  eventHandlers: string[]
}

export type SessionListEntry = {
  sessionId: string
  [extra: string]: JsonValue | undefined
}

export type SessionListResponse = {
  sessions: SessionListEntry[]
  attached: string[]
}
