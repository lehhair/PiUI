/** UI <-> Host protocol. Bump when breaking. */
export const PROTOCOL_VERSION = 1 as const

// --- Transport ---

export interface HostTransport {
  request(cmd: HostCommand): Promise<HostResponse>
  events(): AsyncIterable<HostEvent>
  close?(): Promise<void> | void
}

// --- Commands ---

export type HostCommand =
  | { id?: string; type: "ping" }
  | { id?: string; type: "engine.getVersion" }
  | { id?: string; type: "workspace.open"; cwd: string }
  | { id?: string; type: "workspace.list"; path?: string }
  | { id?: string; type: "workspace.read"; path: string }
  | { id?: string; type: "agent.prompt"; text: string }
  | { id?: string; type: "agent.abort" }
  | { id?: string; type: "agent.getState" }

export type HostResponse =
  | { id?: string; ok: true; type: "pong"; protocolVersion: typeof PROTOCOL_VERSION }
  | { id?: string; ok: true; type: "engine.version"; pi: string; host: string; protocolVersion: number }
  | { id?: string; ok: true; type: "workspace.opened"; cwd: string }
  | { id?: string; ok: true; type: "workspace.list"; nodes: FileNode[] }
  | { id?: string; ok: true; type: "workspace.read"; content: FileContent }
  | { id?: string; ok: true; type: "agent.prompt.accepted" }
  | { id?: string; ok: true; type: "agent.aborted" }
  | { id?: string; ok: true; type: "agent.state"; state: AgentStateSnapshot }
  | { id?: string; ok: false; error: string; code?: string }

// --- Events (Host -> UI) ---

export type HostEvent =
  | { type: "engine.ready"; pi: string; host: string; protocolVersion: number }
  | { type: "agent.event"; payload: unknown }
  | { type: "agent.text_delta"; text: string }
  | { type: "agent.streaming"; streaming: boolean }
  | { type: "permission.request"; id: string; toolName: string; summary: string; detail?: unknown }
  | { type: "workspace.fs"; path: string; kind: "change" | "add" | "unlink" }
  | { type: "error"; message: string }

// --- Shared shapes ---

export type FileNode = {
  name: string
  path: string
  type: "file" | "directory"
  children?: FileNode[]
}

export type FileContent = {
  path: string
  mimeType: string
  encoding: "utf8" | "base64"
  content: string
}

export type AgentStateSnapshot = {
  sessionId: string
  sessionPath?: string
  streaming: boolean
  model?: { provider: string; id: string; name: string }
  thinkingLevel?: string
}
