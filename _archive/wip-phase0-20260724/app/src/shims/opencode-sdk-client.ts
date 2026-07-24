/**
 * 替代 @opencode-ai/sdk/v2/client
 * - 类型：宽松 any，让 UI 类型文件能编译
 * - 运行时：Proxy 返回空数据，页面能起来
 * 后续逐个把 api/* 换成 Pi Host，不再走这里
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpencodeClient = any

function ok(data: unknown) {
  return Promise.resolve({ data })
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

// 类型占位（原 SDK 类型 re-export 用）
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
// catch-all for other imports
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
