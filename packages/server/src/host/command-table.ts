import { HOST_COMMAND_SPECS, PROTOCOL_VERSION, hostSpecToCapability, requireJsonValue, validateParams, type HostCapability, type HostRegistrySnapshot, type JsonObject, type JsonValue } from "@piui/protocol"
import type { SessionHost } from "../pi/session-host.ts"
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  listFiles,
  moveWorkspaceEntry,
  readFileContent,
  writeFileContent,
} from "./files.ts"
import { searchFilesByName, searchWorkspaceText } from "./file-search.ts"
import { getGitDiff, getGitFileDiff, getGitInfo, getGitStatus } from "./git.ts"
import type { WorkspaceStore, WorkspaceRecord } from "./workspace-store.ts"
import type { WorkspaceWatcher } from "./workspace-watcher.ts"
import type { TerminalManager } from "./terminal-manager.ts"

type HostCommandHandler = (ctx: HostCommandContext, params: JsonObject) => JsonValue | undefined | Promise<JsonValue | undefined>

type RegisteredHostCapability = {
  capability: HostCapability
  handler: HostCommandHandler
}

export type HostCommandContext = {
  store: WorkspaceStore
  watcher: WorkspaceWatcher
  sessions: SessionHost
  terminals: TerminalManager
  signal?: AbortSignal
}

export class HostRuntime {
  private revision = 1

  constructor(private readonly ctx: HostCommandContext) {}

  registry(): HostRegistrySnapshot {
    return {
      protocolVersion: PROTOCOL_VERSION,
      revision: this.revision,
      service: "piui-server",
      commands: HOST_CAPABILITIES.map(item => ({ ...item.capability })),
    }
  }

  async execute(name: string, params: JsonObject = {}, options: { signal?: AbortSignal } = {}): Promise<JsonValue | undefined> {
    const registered = HOST_CAPABILITIES.find(item => item.capability.name === name)
    if (!registered) throw Object.assign(new Error(`unknown host command: ${name}`), { code: "UNKNOWN_COMMAND" })
    // HTTP 边缘先用声明的 schema 挡畸形入参，handler 内的解析是第二道
    validateParams(registered.capability.paramsSchema, params)
    return registered.handler({ ...this.ctx, signal: options.signal }, params)
  }
}

function reqString(params: JsonObject, key: string): string {
  const value = params[key]
  if (typeof value !== "string" || !value) {
    throw Object.assign(new Error(`params.${key} must be a non-empty string`), { code: "INVALID_REQUEST" })
  }
  return value
}

function reqStringAllowEmpty(params: JsonObject, key: string): string {
  const value = params[key]
  if (typeof value !== "string") {
    throw Object.assign(new Error(`params.${key} must be a string`), { code: "INVALID_REQUEST" })
  }
  return value
}

function optString(params: JsonObject, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw Object.assign(new Error(`params.${key} must be a string`), { code: "INVALID_REQUEST" })
  return value
}

function optBoolean(params: JsonObject, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw Object.assign(new Error(`params.${key} must be a boolean`), { code: "INVALID_REQUEST" })
  return value
}

function optLimit(params: JsonObject, key: string, fallback: number, maximum: number): number {
  const value = params[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw Object.assign(new Error(`params.${key} must be an integer from 1 to ${maximum}`), { code: "INVALID_REQUEST" })
  }
  return value
}

function workspace(ctx: HostCommandContext, params: JsonObject): WorkspaceRecord {
  const workspacePath = reqString(params, "workspacePath")
  // Host commands may arrive after a server restart, when the in-memory
  // workspace registry is empty. A real directory is enough to re-register it.
  if (ctx.store.isClosed(workspacePath)) {
    throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
  }
  const found = ctx.store.find(workspacePath) ?? ctx.store.resolve(workspacePath)
  ctx.store.assertCurrent(found)
  return found
}

function optSize(params: JsonObject, key: string): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw Object.assign(new Error(`params.${key} must be an integer from 1 to 500`), { code: "INVALID_REQUEST" })
  }
  return value
}

function workspaceDto(record: WorkspaceRecord): JsonObject {
  return {
    path: record.canonicalRoot,
    displayName: record.displayName,
    createdAt: record.createdAt,
    lastOpenedAt: record.lastOpenedAt,
  }
}

function gitMode(params: JsonObject): "git" | "branch" | "staged" | "unstaged" {
  const value = optString(params, "mode") ?? "git"
  if (value !== "git" && value !== "branch" && value !== "staged" && value !== "unstaged") {
    throw Object.assign(new Error("params.mode must be git, branch, staged, or unstaged"), { code: "INVALID_REQUEST" })
  }
  return value
}

function fileSearchType(params: JsonObject): "file" | "directory" | undefined {
  const value = optString(params, "type")
  if (value === undefined || value === "file" || value === "directory") return value
  throw Object.assign(new Error("params.type must be file or directory"), { code: "INVALID_REQUEST" })
}

function fileType(params: JsonObject): "file" | "directory" {
  const value = optString(params, "type")
  if (value === "file" || value === "directory") return value
  throw Object.assign(new Error("params.type must be file or directory"), { code: "INVALID_REQUEST" })
}

function fileEncoding(params: JsonObject): "utf-8" | "base64" | undefined {
  const value = optString(params, "encoding")
  if (value === undefined || value === "utf-8" || value === "base64") return value
  throw Object.assign(new Error("params.encoding must be utf-8 or base64"), { code: "INVALID_REQUEST" })
}

/**
 * 元数据（名字/domain/queue/schema/flags）的唯一来源是 @piui/protocol 的
 * HOST_COMMAND_SPECS；这里只绑定 handler。声明缺 handler 或 handler 没注册，
 * 都在 server 启动时直接炸出来，不允许静默漂移。
 */
const HOST_COMMAND_HANDLERS: Record<string, HostCommandHandler> = {
  "commands.get": (ctx, params) => {
    const record = ctx.sessions.getCommand(reqString(params, "id"))
    if (!record) throw Object.assign(new Error("command not found"), { code: "NOT_FOUND" })
    return requireJsonValue({ command: record })
  },
  "terminals.list": (ctx, params) => ({ terminals: ctx.terminals.list(workspace(ctx, params).canonicalRoot) }),
  "terminals.create": (ctx, params) => ctx.terminals.create(workspace(ctx, params).canonicalRoot, {
    cwd: optString(params, "cwd"),
    shell: optString(params, "shell"),
    title: optString(params, "title"),
    rows: optSize(params, "rows"),
    cols: optSize(params, "cols"),
  }) as Promise<JsonValue>,
  "terminals.get": (ctx, params) => ctx.terminals.get(workspace(ctx, params).canonicalRoot, reqString(params, "terminalId")) as JsonValue,
  "terminals.connectToken": (ctx, params) => ctx.terminals.issueConnectToken(workspace(ctx, params).canonicalRoot, reqString(params, "terminalId")),
  "terminals.update": (ctx, params) => ctx.terminals.update(workspace(ctx, params).canonicalRoot, reqString(params, "terminalId"), {
    title: optString(params, "title"),
    rows: optSize(params, "rows"),
    cols: optSize(params, "cols"),
  }) as JsonValue,
  "terminals.remove": (ctx, params) => {
    ctx.terminals.remove(workspace(ctx, params).canonicalRoot, reqString(params, "terminalId"))
    return { ok: true }
  },
  "workspaces.list": ctx => ({ workspaces: ctx.store.list() }),
  "workspaces.open": (ctx, params) => ({ workspace: workspaceDto(ctx.store.resolve(reqString(params, "rootPath"), optString(params, "displayName"))) }),
  "workspaces.close": (ctx, params) => {
    const record = workspace(ctx, params)
    ctx.terminals.closeWorkspace(record.canonicalRoot)
    ctx.watcher.unwatch(record)
    ctx.store.remove(record.canonicalRoot)
    return { ok: true }
  },
  "workspaces.watch": (ctx, params) => {
    ctx.watcher.watch(workspace(ctx, params))
    return { ok: true }
  },
  "files.list": (ctx, params) => listFiles(workspace(ctx, params), optString(params, "path") ?? "", {
    limit: optLimit(params, "limit", 500, 5000),
    cursor: optString(params, "cursor"),
  }) as Promise<JsonValue>,
  "files.read": (ctx, params) => readFileContent(workspace(ctx, params), reqString(params, "path")) as Promise<JsonValue>,
  "files.write": (ctx, params) => writeFileContent(workspace(ctx, params), reqString(params, "path"), reqStringAllowEmpty(params, "content"), {
    ifMatch: optString(params, "ifMatch"),
    encoding: fileEncoding(params) ?? "utf-8",
  }) as Promise<JsonValue>,
  "files.create": (ctx, params) => createWorkspaceEntry(workspace(ctx, params), reqString(params, "path"), fileType(params), {
    content: optString(params, "content"),
    encoding: fileEncoding(params) ?? "utf-8",
    overwrite: optBoolean(params, "overwrite") === true,
  }) as Promise<JsonValue>,
  "files.move": (ctx, params) => moveWorkspaceEntry(workspace(ctx, params), reqString(params, "from"), reqString(params, "to"), optBoolean(params, "overwrite") === true) as Promise<JsonValue>,
  "files.delete": async (ctx, params) => {
    await deleteWorkspaceEntry(workspace(ctx, params), reqString(params, "path"), optBoolean(params, "recursive") === true)
    return { ok: true }
  },
  "files.searchName": (ctx, params) => searchFilesByName(workspace(ctx, params), reqString(params, "query"), {
    type: fileSearchType(params),
    limit: optLimit(params, "limit", 100, 1000),
    signal: ctx.signal,
  }) as Promise<JsonValue>,
  "files.searchText": (ctx, params) => searchWorkspaceText(workspace(ctx, params), reqString(params, "query"), {
    limit: optLimit(params, "limit", 100, 1000),
    signal: ctx.signal,
  }) as Promise<JsonValue>,
  "git.info": (ctx, params) => getGitInfo(workspace(ctx, params).canonicalRoot, ctx.signal) as Promise<JsonValue>,
  "git.status": (ctx, params) => getGitStatus(workspace(ctx, params).canonicalRoot, ctx.signal) as Promise<JsonValue>,
  "git.diff": (ctx, params) => getGitDiff(workspace(ctx, params).canonicalRoot, gitMode(params), ctx.signal) as Promise<JsonValue>,
  "git.fileDiff": (ctx, params) => getGitFileDiff(workspace(ctx, params).canonicalRoot, gitMode(params), reqString(params, "path"), ctx.signal) as Promise<JsonValue>,
}

export const HOST_CAPABILITIES: RegisteredHostCapability[] = HOST_COMMAND_SPECS.map(spec => {
  const handler = HOST_COMMAND_HANDLERS[spec.name]
  if (!handler) throw new Error(`missing host command implementation: ${spec.name}`)
  return { capability: hostSpecToCapability(spec), handler }
})

for (const name of Object.keys(HOST_COMMAND_HANDLERS)) {
  if (!HOST_COMMAND_SPECS.some(spec => spec.name === name)) {
    throw new Error(`unregistered host command implementation: ${name}`)
  }
}
