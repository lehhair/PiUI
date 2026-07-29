export type ErrorCode =
  | "PROTOCOL_VERSION_MISMATCH"
  | "WORKER_PROTOCOL_MISMATCH"
  | "PI_SDK_VERSION_MISMATCH"
  | "CAPABILITY_DISABLED"
  | "INVALID_REQUEST"
  | "UNKNOWN_COMMAND"
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
  | "RUNTIME_NOT_OPEN"
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

export type Problem = {
  code: ErrorCode
  message: string
  requestId?: string
  retryable?: boolean
  details?: unknown
}

export function problem(
  code: ErrorCode,
  message: string,
  extra?: { requestId?: string; retryable?: boolean; details?: unknown },
): Problem {
  return {
    code,
    message,
    requestId: extra?.requestId,
    retryable: extra?.retryable,
    details: extra?.details,
  }
}

export function problemFromError(error: unknown, fallbackCode: ErrorCode = "INTERNAL"): Problem {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code) as ErrorCode
    : fallbackCode
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  }
}
