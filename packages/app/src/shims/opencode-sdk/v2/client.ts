/**
 * TEMPORARY local stand-in for @opencode-ai/sdk/v2/client.
 * Phase 3: drop npm package. Phase 4: delete this and wire Pi protocol.
 * Not an OpenCode compatibility layer — returns empty data only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpencodeClient = any

function ok(data: unknown) {
  return Promise.resolve({ data, error: undefined })
}

function makeProxy(path: string[] = []): unknown {
  const fn = (..._args: unknown[]) => {
    const leaf = path[path.length - 1] ?? ""
    if (/list|status|diff|files|messages|sessions|providers|agents|skills|todos|find/i.test(leaf)) {
      return ok([])
    }
    if (leaf === "providers") return ok({ providers: [], default: {} })
    if (leaf === "path" || path.includes("path")) {
      return ok({ home: "", state: "", config: "", worktree: "", directory: "" })
    }
    if (leaf === "current") return ok({ id: "local", name: "local", worktree: "" })
    if (leaf === "health") return ok({ healthy: true, version: "piui-shim" })
    return ok({})
  }
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") return undefined
      if (typeof prop === "symbol") return undefined
      return makeProxy([...path, String(prop)])
    },
    apply(_t, _this, _args) {
      return (fn as () => Promise<unknown>)()
    },
  })
}

export function createOpencodeClient(_opts?: unknown): OpencodeClient {
  return makeProxy() as OpencodeClient
}

// Type placeholders used by types/api/* and api/*
export type Agent = any
export type File = any
export type FileContent = any
export type FileNode = any
export type SnapshotFileDiff = any
export type Symbol = any
export type FindTextResponse = any
export type Todo = any
export type GlobalHealthResponse = any
export type FormatterStatus = any
export type LspStatus = any
export type VcsDiffData = any
export type VcsInfo = any
export type AppSkillsResponse = any
export type Message = any
export type UserMessage = any
export type AssistantMessage = any
export type Part = any
export type Session = any
export type PermissionRequest = any
export type Project = any
export type PathResponse = any
export type Provider = any
export type Model = any
export type Event = any
export type Tool = any
export type Worktree = any
export type Pty = any
export type Config = any
export type Command = any
export type QuestionRequest = any
export type McpStatus = any
export type McpLocalConfig = any
export type McpRemoteConfig = any
export type Permission = any
export type ProviderAuth = any
export type SessionStatus = any
export type TextPart = any
export type ReasoningPart = any
export type ToolPart = any
export type FilePart = any
export type AgentPart = any
export type StepStartPart = any
export type StepFinishPart = any
export type SnapshotPart = any
export type PatchPart = any
export type RetryPart = any
export type CompactionPart = any
export type SubtaskPart = any
export type UnknownPart = any
