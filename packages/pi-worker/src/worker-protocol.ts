import type { TimelineItemV1 } from "@piui/protocol"
import type { PiCommandInfo, PiRuntimeUiState, PiSessionInfo, PiSkillInfo } from "./real-session.js"

export interface ProjectionWire {
  timeline: TimelineItemV1[]
  isStreaming: boolean
}

export interface WorkerSessionWire {
  sessionId: string
  sessionFile?: string
  sessionName?: string
  projection: ProjectionWire
  state: PiRuntimeUiState
  entries: unknown[]
  tree: unknown[]
  leafId: string | null
}

export interface PiModelInfo {
  id: string
  name: string
  providerId: string
  family: string
  contextLimit: number
  outputLimit: number
  supportsReasoning: boolean
  supportsImages: boolean
}

export type WorkerCommand =
  | { type: "listAll" }
  | { type: "listModels" }
  | { type: "open"; cwd: string; sessionFile?: string }
  | { type: "prompt"; text: string; deliverAs?: "steer" | "followUp" }
  | { type: "abort" }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinkingLevel"; level: string }
  | { type: "compact"; instructions?: string }
  | { type: "listSkills" }
  | { type: "listCommands" }
  | { type: "dispose" }

export interface WorkerRequest {
  kind: "request"
  id: string
  command: WorkerCommand
}

export type WorkerResult =
  | { type: "sessions"; sessions: PiSessionInfo[] }
  | { type: "models"; models: PiModelInfo[] }
  | { type: "session"; session: WorkerSessionWire }
  | { type: "skills"; skills: PiSkillInfo[] }
  | { type: "commands"; commands: PiCommandInfo[] }
  | { type: "ok" }

export type WorkerResponse =
  | { kind: "response"; id: string; ok: true; result: WorkerResult }
  | { kind: "response"; id: string; ok: false; error: { code: string; message: string } }

export type WorkerIpcEvent =
  | { kind: "event"; type: "projection"; projection: ProjectionWire }
  | { kind: "event"; type: "state"; state: PiRuntimeUiState }

export type WorkerMessage = WorkerResponse | WorkerIpcEvent
