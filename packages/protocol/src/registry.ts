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
  argumentHint?: string
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

export type PiCapabilityScope = "global" | "session"

export type PiCapabilitySource = "pi-sdk" | "pi-extension" | "piui-adapter"

export type PiCapabilityQueue = "immediate" | "serialized"

export type PiCapability = {
  name: string
  scope: PiCapabilityScope
  source: PiCapabilitySource
  description?: string
  paramsSchema?: JsonObject
  resultSchema?: JsonObject
  queue?: PiCapabilityQueue
  replacement?: boolean
  streaming?: boolean
  cancellable?: boolean
  idempotent?: boolean
  requiresRuntime?: boolean
  requiresTrust?: boolean
  [extra: string]: JsonValue | undefined
}

export type PiRegistrySnapshot = {
  protocolVersion: number
  revision: number
  sdkVersion: string
  driver: "mock" | "pi"
  globalCommands: PiCapability[]
  sessionCommands: PiCapability[]
}

export type HostCapabilityDomain = "server" | "commands" | "workspaces" | "files" | "git" | "terminals"

export type HostCapabilityQueue = "immediate" | "serialized"

export type HostCapability = {
  name: string
  domain: HostCapabilityDomain
  description?: string
  paramsSchema?: JsonObject
  resultSchema?: JsonObject
  queue?: HostCapabilityQueue
  idempotent?: boolean
  mutatesWorkspace?: boolean
  emits?: string[]
  [extra: string]: JsonValue | undefined
}

export type HostRegistrySnapshot = {
  protocolVersion: number
  revision: number
  service: "piui-server"
  commands: HostCapability[]
}

export type SessionListEntry = {
  sessionId: string
  [extra: string]: JsonValue | undefined
}

export type SessionListResponse = {
  sessions: SessionListEntry[]
  attached: string[]
}
