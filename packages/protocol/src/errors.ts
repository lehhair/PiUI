export type ErrorCode =
  | "PROTOCOL_VERSION_MISMATCH"
  | "WORKER_PROTOCOL_MISMATCH"
  | "PI_SDK_VERSION_MISMATCH"
  | "CAPABILITY_DISABLED"
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "WORKSPACE_NOT_FOUND"
  | "PATH_OUTSIDE_WORKSPACE"
  | "SYMLINK_ESCAPE"
  | "FILE_TOO_LARGE"
  | "FILE_CONFLICT"
  | "GIT_TIMEOUT"
  | "GIT_OUTPUT_LIMIT"
  | "GIT_BASE_NOT_FOUND"
  | "GIT_FAILED"
  | "STALE_REVISION"
  | "STALE_CURSOR"
  | "SESSION_NOT_FOUND"
  | "SESSION_BUSY"
  | "SESSION_CONFLICT"
  | "SESSION_RUNTIME_CRASHED"
  | "SESSION_IDENTITY_MISMATCH"
  | "RUNTIME_REPLACED"
  | "WORKER_RESULT_UNKNOWN"
  | "DRIVER_UNAVAILABLE"
  | "MODEL_NOT_AVAILABLE"
  | "PROJECT_TRUST_REQUIRED"
  | "EXTENSION_UI_TUI_ONLY"
  | "EXTENSION_UI_LIMIT"
  | "EXTENSION_UI_CANCELLED"
  | "RESPONSE_CONFLICT"
  | "AUTH_REQUIRED"
  | "COMMAND_ALREADY_ACCEPTED"
  | "METHOD_NOT_ALLOWED"
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
