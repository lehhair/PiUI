import type { JsonObject } from "./json.js"
import type { GitDiffMode } from "./git.js"
import type { HostCapability, HostCapabilityDomain, HostCapabilityQueue } from "./registry.js"
import type { TerminalCreateParams, TerminalUpdateParams } from "./terminal.js"
import type { FileCreateRequest, FileMoveRequest } from "./workspace.js"
import { BOOLEAN, EMPTY_PARAMS, STRING, objectSchema } from "./json-schema.js"

/**
 * Host 命令声明表——server/app 两端的单一事实源。
 * server 把 handler 绑定到这里的声明上（缺/多 handler 直接启动失败），
 * app 的 transport 类型从这里派生。
 */
export type HostCommandSpec = {
  name: string
  domain: HostCapabilityDomain
  description: string
  /** 缺省空对象 schema */
  paramsSchema?: JsonObject
  /** 缺省 "immediate" */
  queue?: HostCapabilityQueue
  idempotent?: boolean
  mutatesWorkspace?: boolean
  emits?: string[]
}

export function hostSpecToCapability(spec: HostCommandSpec): HostCapability {
  const { name, domain, description, paramsSchema, queue, idempotent, mutatesWorkspace, emits } = spec
  return {
    name,
    domain,
    description,
    paramsSchema: paramsSchema ?? EMPTY_PARAMS,
    queue: queue ?? "immediate",
    ...(idempotent ? { idempotent } : {}),
    ...(mutatesWorkspace ? { mutatesWorkspace } : {}),
    ...(emits ? { emits: [...emits] } : {}),
  }
}

const WORKSPACE_PATH = { workspacePath: STRING }
const RELATIVE_PATH = { path: STRING }
const LIMIT_CURSOR = { limit: { type: "integer", minimum: 1 }, cursor: STRING }
const GIT_MODE: JsonObject = { enum: ["git", "branch", "staged", "unstaged"] }
const TERMINAL_ID = { terminalId: STRING }
const TERMINAL_SIZE = {
  rows: { type: "integer", minimum: 1, maximum: 500 },
  cols: { type: "integer", minimum: 1, maximum: 500 },
}
const FILE_ENCODING: JsonObject = { enum: ["utf-8", "base64"] }

export const HOST_COMMAND_SPECS = [
  {
    name: "commands.get",
    domain: "commands",
    description: "Read a queued Pi command lifecycle record by id",
    paramsSchema: objectSchema({ id: STRING }, ["id"]),
    idempotent: true,
  },
  {
    name: "terminals.shells",
    domain: "terminals",
    description: "List available shells on the PiUI server host",
    idempotent: true,
  },
  {
    name: "terminals.list",
    domain: "terminals",
    description: "List terminal sessions owned by a workspace",
    paramsSchema: objectSchema(WORKSPACE_PATH, ["workspacePath"]),
    idempotent: true,
  },
  {
    name: "terminals.create",
    domain: "terminals",
    description: "Create an interactive terminal session in a workspace",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, cwd: STRING, shell: STRING, title: STRING, ...TERMINAL_SIZE }, ["workspacePath"]),
    emits: ["terminal.created"],
  },
  {
    name: "terminals.get",
    domain: "terminals",
    description: "Read one terminal session",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...TERMINAL_ID }, ["workspacePath", "terminalId"]),
    idempotent: true,
  },
  {
    name: "terminals.connectToken",
    domain: "terminals",
    description: "Issue a one-time token for a terminal WebSocket",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...TERMINAL_ID }, ["workspacePath", "terminalId"]),
  },
  {
    name: "terminals.update",
    domain: "terminals",
    description: "Rename or resize a terminal session",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...TERMINAL_ID, title: STRING, ...TERMINAL_SIZE }, ["workspacePath", "terminalId"]),
    emits: ["terminal.updated"],
  },
  {
    name: "terminals.remove",
    domain: "terminals",
    description: "Terminate and remove a terminal session",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...TERMINAL_ID }, ["workspacePath", "terminalId"]),
    emits: ["terminal.deleted"],
  },
  {
    name: "workspaces.list",
    domain: "workspaces",
    description: "List workspaces known to this PiUI server",
    idempotent: true,
  },
  {
    name: "workspaces.open",
    domain: "workspaces",
    description: "Validate and remember a host directory as a workspace; rootPath defaults to the server install directory",
    paramsSchema: objectSchema({ rootPath: STRING, displayName: STRING }),
    mutatesWorkspace: true,
    emits: ["sessions.updated"],
  },
  {
    name: "workspaces.close",
    domain: "workspaces",
    description: "Forget a workspace and stop watching it",
    paramsSchema: objectSchema(WORKSPACE_PATH, ["workspacePath"]),
    mutatesWorkspace: true,
  },
  {
    name: "workspaces.watch",
    domain: "workspaces",
    description: "Start publishing file and Git events for a workspace",
    paramsSchema: objectSchema(WORKSPACE_PATH, ["workspacePath"]),
    emits: ["workspace.files", "workspace.git"],
  },
  {
    name: "files.list",
    domain: "files",
    description: "List files in a workspace directory",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, path: STRING, ...LIMIT_CURSOR }, ["workspacePath"]),
    idempotent: true,
  },
  {
    name: "files.read",
    domain: "files",
    description: "Read a text or small binary workspace file",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...RELATIVE_PATH }, ["workspacePath", "path"]),
    idempotent: true,
  },
  {
    name: "files.write",
    domain: "files",
    description: "Write a workspace file using optional ETag protection",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...RELATIVE_PATH, content: STRING, encoding: FILE_ENCODING, ifMatch: STRING }, ["workspacePath", "path", "content"]),
    queue: "serialized",
    mutatesWorkspace: true,
    emits: ["workspace.files", "workspace.git"],
  },
  {
    name: "files.create",
    domain: "files",
    description: "Create a workspace file or directory",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...RELATIVE_PATH, type: { enum: ["file", "directory"] }, content: STRING, encoding: FILE_ENCODING, overwrite: BOOLEAN }, ["workspacePath", "path", "type"]),
    queue: "serialized",
    mutatesWorkspace: true,
    emits: ["workspace.files", "workspace.git"],
  },
  {
    name: "files.move",
    domain: "files",
    description: "Move or rename a workspace entry",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, from: STRING, to: STRING, overwrite: BOOLEAN }, ["workspacePath", "from", "to"]),
    queue: "serialized",
    mutatesWorkspace: true,
    emits: ["workspace.files", "workspace.git"],
  },
  {
    name: "files.delete",
    domain: "files",
    description: "Delete a workspace entry",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...RELATIVE_PATH, recursive: BOOLEAN }, ["workspacePath", "path"]),
    queue: "serialized",
    mutatesWorkspace: true,
    emits: ["workspace.files", "workspace.git"],
  },
  {
    name: "files.searchName",
    domain: "files",
    description: "Search workspace paths by name",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, query: STRING, type: { enum: ["file", "directory"] }, limit: { type: "integer", minimum: 1 } }, ["workspacePath", "query"]),
    idempotent: true,
  },
  {
    name: "files.searchText",
    domain: "files",
    description: "Search workspace text files",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, query: STRING, limit: { type: "integer", minimum: 1 } }, ["workspacePath", "query"]),
    idempotent: true,
  },
  {
    name: "git.info",
    domain: "git",
    description: "Read Git repository information for a workspace",
    paramsSchema: objectSchema(WORKSPACE_PATH, ["workspacePath"]),
    idempotent: true,
  },
  {
    name: "git.status",
    domain: "git",
    description: "Read Git working tree status for a workspace",
    paramsSchema: objectSchema(WORKSPACE_PATH, ["workspacePath"]),
    idempotent: true,
  },
  {
    name: "git.diff",
    domain: "git",
    description: "Read Git diff summary for a workspace",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, mode: GIT_MODE }, ["workspacePath"]),
    idempotent: true,
  },
  {
    name: "git.fileDiff",
    domain: "git",
    description: "Read Git patch for one changed file",
    paramsSchema: objectSchema({ ...WORKSPACE_PATH, ...RELATIVE_PATH, mode: GIT_MODE }, ["workspacePath", "path"]),
    idempotent: true,
  },
] as const satisfies readonly HostCommandSpec[]

export type HostCommandName = (typeof HOST_COMMAND_SPECS)[number]["name"]

/** 每条 host 命令的 TS 入参类型——与上面的 paramsSchema 同文件维护 */
export type HostCommandParams = {
  "commands.get": { id: string }
  "terminals.shells": Record<string, never>
  "terminals.list": { workspacePath: string }
  "terminals.create": { workspacePath: string } & TerminalCreateParams
  "terminals.get": { workspacePath: string; terminalId: string }
  "terminals.connectToken": { workspacePath: string; terminalId: string }
  "terminals.update": { workspacePath: string; terminalId: string } & TerminalUpdateParams
  "terminals.remove": { workspacePath: string; terminalId: string }
  "workspaces.list": Record<string, never>
  "workspaces.open": { rootPath?: string; displayName?: string }
  "workspaces.close": { workspacePath: string }
  "workspaces.watch": { workspacePath: string }
  "files.list": { workspacePath: string; path?: string; limit?: number; cursor?: string }
  "files.read": { workspacePath: string; path: string }
  "files.write": { workspacePath: string; path: string; content: string; encoding?: "utf-8" | "base64"; ifMatch?: string }
  "files.create": { workspacePath: string } & FileCreateRequest
  "files.move": { workspacePath: string } & FileMoveRequest
  "files.delete": { workspacePath: string; path: string; recursive?: boolean }
  "files.searchName": { workspacePath: string; query: string; type?: "file" | "directory"; limit?: number }
  "files.searchText": { workspacePath: string; query: string; limit?: number }
  "git.info": { workspacePath: string }
  "git.status": { workspacePath: string }
  "git.diff": { workspacePath: string; mode?: GitDiffMode }
  "git.fileDiff": { workspacePath: string; path: string; mode?: GitDiffMode }
}

// 编译期防漂移：参数映射表的键必须与声明表的命令名完全一致
type Assert<Condition extends true> = Condition
type _HostParamsCoverAllSpecs = Assert<HostCommandName extends keyof HostCommandParams ? true : false>
type _HostParamsHaveNoExtras = Assert<Exclude<keyof HostCommandParams, HostCommandName> extends never ? true : false>
