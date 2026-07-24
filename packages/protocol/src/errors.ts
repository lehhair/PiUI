export type ErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "WORKSPACE_NOT_FOUND"
  | "PATH_OUTSIDE_WORKSPACE"
  | "SYMLINK_ESCAPE"
  | "FILE_TOO_LARGE"
  | "STALE_REVISION"
  | "SESSION_NOT_FOUND"
  | "SESSION_BUSY"
  | "SESSION_CONFLICT"
  | "SESSION_RUNTIME_CRASHED"
  | "DRIVER_UNAVAILABLE"
  | "MODEL_NOT_AVAILABLE"
  | "PROJECT_TRUST_REQUIRED"
  | "EXTENSION_UI_UNSUPPORTED"
  | "COMMAND_ALREADY_ACCEPTED"
  | "RESYNC_REQUIRED"
  | "NOT_FOUND"
  | "INTERNAL"

export interface ProblemV1 {
  protocolVersion: 1
  code: ErrorCode
  message: string
  requestId?: string
  details?: unknown
}

export function problem(
  code: ErrorCode,
  message: string,
  extra?: { requestId?: string; details?: unknown },
): ProblemV1 {
  return {
    protocolVersion: 1,
    code,
    message,
    requestId: extra?.requestId,
    details: extra?.details,
  }
}
