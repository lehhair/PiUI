export type CommandStatusV1 = "accepted" | "running" | "completed" | "failed" | "cancelled"

export interface CommandRecordV1 {
  commandId: string
  sessionId: string
  kind: string
  status: CommandStatusV1
  submittedAt: string
  startedAt?: string
  completedAt?: string
  error?: { code: string; message: string }
}
