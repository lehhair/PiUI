import type {
  CompactionCommandResultV1,
  PiNavigationResultV1,
  PiSessionEntryV1,
  PiSessionTreeNodeV1,
  QueueDeliveryModeV1,
  SessionReplacementResultV1,
  TimelineItemV1,
} from "@piui/protocol"
import type { PiCommandInfo, PiRuntimeUiState, PiSessionInfo, PiSkillInfo } from "./real-session.js"

export interface ProjectionWire {
  timeline: TimelineItemV1[]
  isStreaming: boolean
  removedItemIds?: string[]
}

export interface WorkerSessionWire {
  sessionId: string
  sessionFile?: string
  sessionName?: string
  projection: ProjectionWire
  state: PiRuntimeUiState
  entries: PiSessionEntryV1[]
  tree: PiSessionTreeNodeV1[]
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
  thinkingLevels: string[]
  supportsImages: boolean
}

export interface PiImageInput {
  type: "image"
  data: string
  mimeType: string
}

export interface PiBashResult {
  output: string
  exitCode?: number
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
}

export const PI_WORKER_PROTOCOL_VERSION = 5 as const
export const PI_WORKER_HEARTBEAT_INTERVAL_MS = 5_000

export type PiWorkerCapability =
  | "catalog.sessions"
  | "catalog.models"
  | "runtime.open"
  | "runtime.prompt"
  | "runtime.control"
  | "runtime.abort"
  | "runtime.model"
  | "runtime.thinking"
  | "runtime.compact"
  | "runtime.retry"
  | "runtime.tools"
  | "runtime.tree"
  | "runtime.fork"
  | "runtime.import"
  | "runtime.skills"
  | "runtime.commands"
  | "runtime.bash"
  | "runtime.export"
  | "runtime.reload"

export interface WorkerHello {
  kind: "hello"
  workerProtocolVersion: number
  piSdkVersion: string
  generation: string
  processId: number
  heartbeatIntervalMs: number
  capabilities: PiWorkerCapability[]
}

export type WorkerCommand =
  | { type: "list"; cwd: string }
  | { type: "listAll" }
  | { type: "listModels" }
  | { type: "open"; cwd: string; sessionFile?: string }
  | { type: "prompt"; text: string; images?: PiImageInput[] }
  | { type: "steer"; text: string; images?: PiImageInput[] }
  | { type: "followUp"; text: string; images?: PiImageInput[] }
  | { type: "abort" }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinkingLevel"; level: string }
  | { type: "compact"; instructions?: string }
  | { type: "abortCompaction" }
  | { type: "abortBranchSummary" }
  | { type: "abortRetry" }
  | { type: "setAutoCompaction"; enabled: boolean }
  | { type: "setAutoRetry"; enabled: boolean }
  | {
      type: "setQueueModes"
      steeringMode?: QueueDeliveryModeV1
      followUpMode?: QueueDeliveryModeV1
    }
  | { type: "clearQueue" }
  | { type: "setActiveTools"; toolNames: string[] }
  | { type: "executeBash"; command: string; excludeFromContext?: boolean }
  | { type: "abortBash" }
  | { type: "exportHtml"; outputPath: string }
  | { type: "exportJsonl"; outputPath: string }
  | { type: "reload" }
  | {
      type: "navigateTree"
      entryId: string
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    }
  | { type: "setLabel"; entryId: string; label?: string }
  | { type: "setSessionName"; name: string }
  | { type: "fork"; entryId: string; position: "before" | "at" }
  | { type: "clone"; entryId?: string }
  | { type: "importSession"; inputPath: string; cwdOverride?: string }
  | { type: "listSkills" }
  | { type: "listCommands" }
  | { type: "dispose" }

export interface WorkerRequest {
  kind: "request"
  id: string
  generation: string
  command: WorkerCommand
}

export type WorkerResult =
  | { type: "sessions"; sessions: PiSessionInfo[] }
  | { type: "models"; models: PiModelInfo[] }
  | { type: "session"; session: WorkerSessionWire }
  | { type: "skills"; skills: PiSkillInfo[] }
  | { type: "commands"; commands: PiCommandInfo[] }
  | { type: "bash"; result: PiBashResult; session: WorkerSessionWire }
  | { type: "export"; format: "html" | "jsonl"; path: string }
  | ({ type: "navigation"; session: WorkerSessionWire } & PiNavigationResultV1)
  | { type: "compaction"; compaction: CompactionCommandResultV1; session: WorkerSessionWire }
  | { type: "queue"; steering: string[]; followUp: string[]; session: WorkerSessionWire }
  | { type: "replacement"; replacement: SessionReplacementResultV1; session: WorkerSessionWire }
  | { type: "ok" }

export type WorkerResponse =
  | { kind: "response"; id: string; generation: string; ok: true; result: WorkerResult }
  | { kind: "response"; id: string; generation: string; ok: false; error: { code: string; message: string } }

export type WorkerIpcEvent =
  | { kind: "event"; generation: string; type: "projection"; projection: ProjectionWire }
  | { kind: "event"; generation: string; type: "projectionDelta"; projection: ProjectionWire }
  | { kind: "event"; generation: string; type: "state"; state: PiRuntimeUiState }

export interface WorkerHeartbeat {
  kind: "heartbeat"
  generation: string
  timestamp: number
}

export type WorkerMessage = WorkerHello | WorkerResponse | WorkerIpcEvent | WorkerHeartbeat
