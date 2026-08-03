import { PROTOCOL_VERSION, requireJsonValue, type HostCapability, type HostRegistrySnapshot, type JsonObject, type JsonValue } from "@piui/protocol"
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

type CapabilityOptions = {
  name: string
  domain: HostCapability["domain"]
  description: string
  paramsSchema?: JsonObject
  resultSchema?: JsonObject
  queue?: HostCapability["queue"]
  idempotent?: boolean
  mutatesWorkspace?: boolean
  emits?: string[]
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
    return registered.handler({ ...this.ctx, signal: options.signal }, params)
  }
}

function registerHostCapability({ handler, ...capability }: CapabilityOptions): RegisteredHostCapability {
  return {
    capability: {
      queue: "immediate",
      paramsSchema: EMPTY_PARAMS,
      ...capability,
    },
    handler,
  }
}

const STRING: JsonObject = { type: "string" }
const BOOLEAN: JsonObject = { type: "boolean" }
const EMPTY_PARAMS = objectSchema({})
const WORKSPACE_PATH = { workspacePath: STRING }
const RELATIVE_PATH = { path: STRING }
const LIMIT_CURSOR = { limit: { type: "integer", minimum: 1 }, cursor: STRING }
const GIT_MODE: JsonObject = { enum: ["git", "branch", "staged", "unstaged"] }

function objectSchema(properties: Record<string, JsonObject>, required: string[] = [], additionalProperties = false): JsonObject {
  return { type: "object", additionalProperties, required, properties }
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
  const found = ctx.store.find(reqString(params, "workspacePath"))
  if (!found) throw Object.assign(new Error("workspace not found"), { code: "WORKSPACE_NOT_FOUND" })
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

export const HOST_CAPABILITIES = [
  registerHostCapability({
    name: "commands.get",
    domain: "commands",
    description: "Read a queued Pi command lifecycle record by id",
    paramsSchema: objectSchema({ id: STRING }, ["id"]),
    idempotent: true,
    handler: (ctx, params) => {
      const record = ctx.sessions.getCommand(reqString(params, "id"))
      if (!record) throw Object.assign(new Error("command not found"), { code: "NOT_FOUND" })
      return requireJsonValue({ command: record })
    },
  }),
  registerHostCapability({
    name: "terminals.list",
    domain: "terminals",
    description: "List terminal sessions owned by a workspace",
    paramsSchema: objectSchema(WORKSPACE_PATH, ["workspacePath"]),
    idempotent: true,
    handler: (ctx, params) => ({ terminals: ctx.terminals.list(workspace(ctx, params).canonicalRoot) }),
  }),
  registerHostCapability({
    name: "terminals.create",
    domain: "terminals",
    description: "Create an interactive terminal session in a workspace",
    paramsSchema: objectSchema({
      ...WORKSPACE_PATH,
      cwd: STRING,
      shell: STRING,
      title: STRING,
      rows: { type: "integer", minimum: 1, maximum: 500 },
      cols: { type: "integer", minimum: 1, maximum: 500 },
    }, ["workspacePath"]),
    emits: ["terminal.created"],
    handler: (ctx, params) => ctx.terminals.create(workspace(ctx, params).canonicalRoot, {
      cwd: optString(params, "cwd"),
      shell: optString(params, "shell"),
      title: optString(params, "title"),
      rows: optSize(params, "rows"),
      cols: optSize(params, "cols"),
    }) as Promise<JsonValue>,
  }),
  registerHostCapability({
    name: "terminals.get",
    domain: "terminals",
    description: "Read one terminal session",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, terminalId: STRING }, ["workspacePath", "terminalId"]),
    idempotent: true,
    handler: (ctx, params) => ctx.terminals.get(workspace(ctx, params).canonicalRoot, reqString(params, "terminalId")) as JsonValue,
  }),
  registerHostCapability({
    name: "terminals.connectToken",
    domain: "terminals",
    description: "Issue a one-time token for a terminal WebSocket",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, terminalId: STRING }, ["workspacePath", "terminalId"]),
    handler: (ctx, params) => ctx.terminals.issueConnectToken(workspace(ctx, params).canonicalRoot, reqString(params, "terminalId")),
  }),
  registerHostCapability({
    name: "terminals.update",
    domain: "terminals",
    description: "Rename or resize a terminal session",
    paramsSchema: objectSchema({
      ...WORKSPACE_PATH,
      terminalId: STRING,
      title: STRING,
      rows: { type: "integer", minimum: 1, maximum: 500 },
      cols: { type: "integer", minimum: 1, maximum: 500 },
    }, ["workspacePath", "terminalId"]),
    emits: ["terminal.updated"],
    handler: (ctx, params) => ctx.terminals.update(workspace(ctx, params).canonicalRoot, reqString(params, "terminalId"), {
      title: optString(params, "title"),
      rows: optSize(params, "rows"),
      cols: optSize(params, "cols"),
    }) as JsonValue,
  }),
  registerHostCapability({
    name: "terminals.remove",
    domain: "terminals",
    description: "Terminate and remove a terminal session",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, terminalId: STRING }, ["workspacePath", "terminalId"]),
    emits: ["terminal.deleted"],
    handler: (ctx, params) => {
      ctx.terminals.remove(workspace(ctx, params).canonicalRoot, reqString(params, "terminalId"))
      return { ok: true }
    },
  }),
  registerHostCapability({
    name: "workspaces.list",
    domain: "workspaces",
    description: "List workspaces known to this PiUI server",
    idempotent: true,
    handler: ctx => ({ workspaces: ctx.store.list() }),
  }),
  registerHostCapability({
    name: "workspaces.open",
    domain: "workspaces",
    description: "Validate and remember a host directory as a workspace",
    paramsSchema: objectSchema({ rootPath: STRING, displayName: STRING }, ["rootPath"]),
    mutatesWorkspace: true,
    emits: ["sessions.updated"],
    handler: (ctx, params) => ({ workspace: workspaceDto(ctx.store.resolve(reqString(params, "rootPath"), optString(params, "displayName"))) }),
  }),
  registerHostCapability({
    name: "workspaces.close",
    domain: "workspaces",
    description: "Forget a workspace and stop watching it",
    paramsSchema: objectSchema(WORKSPACE_PATH, ["workspacePath"]),
    mutatesWorkspace: true,
    handler: (ctx, params) => {
      const record = workspace(ctx, params)
      ctx.terminals.closeWorkspace(record.canonicalRoot)
      ctx.watcher.unwatch(record)
      ctx.store.remove(record.canonicalRoot)
      return { ok: true }
    },
  }),
  registerHostCapability({
    name: "workspaces.watch",
    domain: "workspaces",
    description: "Start publishing file and Git events for a workspace",
    paramsSchema: objectSchema(WORKSPACE_PATH, ["workspacePath"]),
    emits: ["workspace.files", "workspace.git"],
    handler: (ctx, params) => {
      ctx.watcher.watch(workspace(ctx, params))
      return { ok: true }
    },
  }),
  registerHostCapability({
    name: "files.list",
    domain: "files",
    description: "List files in a workspace directory",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, path: STRING, ...LIMIT_CURSOR }, ["workspacePath"]),
    idempotent: true,
    handler: (ctx, params) => listFiles(workspace(ctx, params), optString(params, "path") ?? "", {
      limit: optLimit(params, "limit", 500, 5000),
      cursor: optString(params, "cursor"),
    }) as Promise<JsonValue>,
  }),
  registerHostCapability({
    name: "files.read",
    domain: "files",
    description: "Read a text or small binary workspace file",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...RELATIVE_PATH }, ["workspacePath", "path"]),
    idempotent: true,
    handler: (ctx, params) => readFileContent(workspace(ctx, params), reqString(params, "path")) as Promise<JsonValue>,
  }),
  registerHostCapability({
    name: "files.write",
    domain: "files",
    description: "Write a workspace file using optional ETag protection",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...RELATIVE_PATH, content: STRING, encoding: { enum: ["utf-8", "base64"] }, ifMatch: STRING }, ["workspacePath", "path", "content"]),
    queue: "serialized",
    mutatesWorkspace: true,
    emits: ["workspace.files", "workspace.git"],
    handler: (ctx, params) => writeFileContent(workspace(ctx, params), reqString(params, "path"), reqStringAllowEmpty(params, "content"), {
      ifMatch: optString(params, "ifMatch"),
      encoding: fileEncoding(params) ?? "utf-8",
    }) as Promise<JsonValue>,
  }),
  registerHostCapability({
    name: "files.create",
    domain: "files",
    description: "Create a workspace file or directory",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...RELATIVE_PATH, type: { enum: ["file", "directory"] }, content: STRING, encoding: { enum: ["utf-8", "base64"] }, overwrite: BOOLEAN }, ["workspacePath", "path", "type"]),
    queue: "serialized",
    mutatesWorkspace: true,
    emits: ["workspace.files", "workspace.git"],
    handler: (ctx, params) => createWorkspaceEntry(workspace(ctx, params), reqString(params, "path"), fileType(params), {
      content: optString(params, "content"),
      encoding: fileEncoding(params) ?? "utf-8",
      overwrite: optBoolean(params, "overwrite") === true,
    }) as Promise<JsonValue>,
  }),
  registerHostCapability({
    name: "files.move",
    domain: "files",
    description: "Move or rename a workspace entry",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, from: STRING, to: STRING, overwrite: BOOLEAN }, ["workspacePath", "from", "to"]),
    queue: "serialized",
    mutatesWorkspace: true,
    emits: ["workspace.files", "workspace.git"],
    handler: (ctx, params) => moveWorkspaceEntry(workspace(ctx, params), reqString(params, "from"), reqString(params, "to"), optBoolean(params, "overwrite") === true) as Promise<JsonValue>,
  }),
  registerHostCapability({
    name: "files.delete",
    domain: "files",
    description: "Delete a workspace entry",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...RELATIVE_PATH, recursive: BOOLEAN }, ["workspacePath", "path"]),
    queue: "serialized",
    mutatesWorkspace: true,
    emits: ["workspace.files", "workspace.git"],
    handler: async (ctx, params) => {
      await deleteWorkspaceEntry(workspace(ctx, params), reqString(params, "path"), optBoolean(params, "recursive") === true)
      return { ok: true }
    },
  }),
  registerHostCapability({
    name: "files.searchName",
    domain: "files",
    description: "Search workspace paths by name",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, query: STRING, type: { enum: ["file", "directory"] }, limit: { type: "integer", minimum: 1 } }, ["workspacePath", "query"]),
    idempotent: true,
    handler: (ctx, params) => searchFilesByName(workspace(ctx, params), reqString(params, "query"), {
      type: fileSearchType(params),
      limit: optLimit(params, "limit", 100, 1000),
      signal: ctx.signal,
    }) as Promise<JsonValue>,
  }),
  registerHostCapability({
    name: "files.searchText",
    domain: "files",
    description: "Search workspace text files",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, query: STRING, limit: { type: "integer", minimum: 1 } }, ["workspacePath", "query"]),
    idempotent: true,
    handler: (ctx, params) => searchWorkspaceText(workspace(ctx, params), reqString(params, "query"), {
      limit: optLimit(params, "limit", 100, 1000),
      signal: ctx.signal,
    }) as Promise<JsonValue>,
  }),
  registerHostCapability({
    name: "git.info",
    domain: "git",
    description: "Read Git repository information for a workspace",
    paramsSchema: objectSchema(WORKSPACE_PATH, ["workspacePath"]),
    idempotent: true,
    handler: (ctx, params) => getGitInfo(workspace(ctx, params).canonicalRoot, ctx.signal) as Promise<JsonValue>,
  }),
  registerHostCapability({
    name: "git.status",
    domain: "git",
    description: "Read Git working tree status for a workspace",
    paramsSchema: objectSchema(WORKSPACE_PATH, ["workspacePath"]),
    idempotent: true,
    handler: (ctx, params) => getGitStatus(workspace(ctx, params).canonicalRoot, ctx.signal) as Promise<JsonValue>,
  }),
  registerHostCapability({
    name: "git.diff",
    domain: "git",
    description: "Read Git diff summary for a workspace",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, mode: GIT_MODE }, ["workspacePath"]),
    idempotent: true,
    handler: (ctx, params) => getGitDiff(workspace(ctx, params).canonicalRoot, gitMode(params), ctx.signal) as Promise<JsonValue>,
  }),
  registerHostCapability({
    name: "git.fileDiff",
    domain: "git",
    description: "Read Git patch for one changed file",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...RELATIVE_PATH, mode: GIT_MODE }, ["workspacePath", "path"]),
    idempotent: true,
    handler: (ctx, params) => getGitFileDiff(workspace(ctx, params).canonicalRoot, gitMode(params), reqString(params, "path"), ctx.signal) as Promise<JsonValue>,
  }),
]
