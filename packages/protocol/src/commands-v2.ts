export type CommandConcurrencyV2 = "query" | "idle-only" | "run-control" | "queueable"

export interface CommandPayloadsV2 {
  "session.prompt": {
    text: string
    attachments?: Array<{ type: "image"; mimeType: string; data: string }>
    model?: { provider: string; modelId: string }
  }
  "session.steer": { text: string }
  "session.followUp": { text: string }
  "session.abort": Record<string, never>
  "session.setModel": { provider: string; modelId: string }
  "session.setThinkingLevel": { level: string }
  "session.compact": { instructions?: string }
  "session.abortCompaction": Record<string, never>
  "session.setAutoCompaction": { enabled: boolean }
  "session.setAutoRetry": { enabled: boolean }
  "session.abortRetry": Record<string, never>
  "session.abortBranchSummary": Record<string, never>
  "session.setQueueModes": {
    steeringMode?: "all" | "one-at-a-time"
    followUpMode?: "all" | "one-at-a-time"
  }
  "session.clearQueue": Record<string, never>
  "session.setActiveTools": { toolNames: string[] }
  "session.navigateTree": {
    entryId: string
    summarizeAbandonedBranch?: boolean
    customInstructions?: string
    replaceInstructions?: boolean
    label?: string
  }
  "session.setLabel": { entryId: string; label?: string }
  "session.setName": { name: string }
  "session.fork": { entryId: string; position: "before" | "at" }
  "session.clone": { entryId?: string }
  "session.import": { inputPath: string; cwdOverride?: string }
  "session.delete": { durable: true }
  "extension.ui.respond": { requestId: string; value?: unknown; cancelled?: boolean }
  "resources.reload": { workspaceId?: string }
}

export type CommandTypeV2 = keyof CommandPayloadsV2

export interface CommandRequestV2<T extends CommandTypeV2 = CommandTypeV2> {
  protocolVersion: 2
  commandId: string
  type: T
  concurrency: CommandConcurrencyV2
  sessionId?: string
  workspaceId?: string
  payload: CommandPayloadsV2[T]
}

export type CommandStatusV2 =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown_after_crash"

export interface CommandRecordV2<T extends CommandTypeV2 = CommandTypeV2> {
  request: CommandRequestV2<T>
  status: CommandStatusV2
  submittedAt: string
  startedAt?: string
  completedAt?: string
  error?: { code: string; message: string; retryable?: boolean }
}
