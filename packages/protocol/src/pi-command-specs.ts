import type { JsonObject } from "./json.js"
import type { CoreCommandParams } from "./commands.js"
import type { PiCapability, PiCapabilityQueue, PiCapabilityScope, PiCapabilitySource } from "./registry.js"
import {
  ANY_JSON,
  BOOLEAN,
  EMPTY_PARAMS,
  IMAGE_INPUT,
  IMAGES,
  STRING,
  STRING_ARRAY,
  nullable,
  objectSchema,
  pageParams,
} from "./json-schema.js"

/**
 * Pi 命令声明表——worker/server/app 三端的单一事实源。
 * worker 把 handler 绑定到这里的声明上（缺/多 handler 直接启动失败），
 * server 用它做命令路由和能力合并，app 的 transport 类型从这里派生。
 * Pi SDK 新增能力时只改这一个文件 + worker 的 handler。
 */
export type PiCommandSpec = {
  name: string
  scope: PiCapabilityScope
  description: string
  /** 缺省 "pi-sdk"；扩展逃生门（invokeTool/invokeCommand）标 "pi-extension" */
  source?: PiCapabilitySource
  /** 缺省空对象 schema */
  paramsSchema?: JsonObject
  queue: PiCapabilityQueue
  replacement?: boolean
  streaming?: boolean
  cancellable?: boolean
  idempotent?: boolean
}

export function piSpecToCapability(spec: PiCommandSpec): PiCapability {
  const { name, scope, description, source, paramsSchema, queue, replacement, streaming, cancellable, idempotent } = spec
  return {
    name,
    scope,
    description,
    source: source ?? "pi-sdk",
    paramsSchema: paramsSchema ?? EMPTY_PARAMS,
    queue,
    ...(replacement ? { replacement } : {}),
    ...(streaming ? { streaming } : {}),
    ...(cancellable ? { cancellable } : {}),
    ...(idempotent ? { idempotent } : {}),
  }
}

const QUEUE_MODE: JsonObject = { enum: ["all", "one-at-a-time"] }
const PROMPT_PARAMS = objectSchema(
  { text: STRING, images: IMAGES, expandPromptTemplates: BOOLEAN, streamingBehavior: { type: "string", enum: ["steer", "followUp"] } },
  ["text"],
)
const TEXT_IMAGES_PARAMS = objectSchema({ text: STRING, images: IMAGES }, ["text"])
const OUTPUT_PATH_PARAMS = objectSchema({ outputPath: STRING }, ["outputPath"])
const CWD_PARAMS = objectSchema({ cwd: STRING }, ["cwd"])
const SESSION_PREVIEW_PARAMS = objectSchema({
  sessionId: STRING,
  cursor: nullable(STRING),
  limit: { type: "integer", minimum: 1 },
  maxBytes: { type: "integer", minimum: 1 },
}, ["sessionId"])

export const PI_COMMAND_SPECS = [
  { name: "prompt", scope: "session", description: "Send a user prompt to the current Pi session", paramsSchema: PROMPT_PARAMS, queue: "serialized", streaming: true, cancellable: true },
  { name: "steer", scope: "session", description: "Queue steering text for the current Pi session", paramsSchema: TEXT_IMAGES_PARAMS, queue: "immediate" },
  { name: "followUp", scope: "session", description: "Queue a follow-up message for the current Pi session", paramsSchema: TEXT_IMAGES_PARAMS, queue: "immediate" },
  { name: "sendUserMessage", scope: "session", description: "Append and optionally deliver a user message", paramsSchema: objectSchema({ text: STRING, images: IMAGES, deliverAs: { enum: ["steer", "followUp"] } }, ["text"]), queue: "immediate" },
  { name: "abort", scope: "session", description: "Abort the current Pi turn", queue: "immediate" },
  { name: "newSession", scope: "session", description: "Create a new Pi session from the current runtime", paramsSchema: objectSchema({ parentSession: STRING }), queue: "serialized", replacement: true },
  { name: "switchSession", scope: "session", description: "Switch the runtime to another Pi session file", paramsSchema: objectSchema({ sessionPath: STRING, cwdOverride: STRING }, ["sessionPath"]), queue: "serialized", replacement: true },
  { name: "fork", scope: "session", description: "Fork the current Pi session at an entry", paramsSchema: objectSchema({ entryId: STRING, position: { enum: ["before", "at"] } }, ["entryId"]), queue: "serialized", replacement: true },
  { name: "importSession", scope: "session", description: "Import a Pi session file", paramsSchema: objectSchema({ inputPath: STRING, cwdOverride: STRING }, ["inputPath"]), queue: "serialized", replacement: true },
  { name: "setSessionName", scope: "session", description: "Set the current Pi session name", paramsSchema: objectSchema({ name: STRING }, ["name"]), queue: "serialized" },
  { name: "setModel", scope: "session", description: "Set provider and model for the current Pi session", paramsSchema: objectSchema({ provider: STRING, modelId: STRING }, ["provider", "modelId"]), queue: "serialized" },
  { name: "cycleModel", scope: "session", description: "Cycle the selected model", paramsSchema: objectSchema({ direction: { enum: ["forward", "backward"] } }), queue: "serialized" },
  { name: "setScopedModels", scope: "session", description: "Set scoped model patterns", paramsSchema: objectSchema({ patterns: STRING_ARRAY }), queue: "serialized" },
  { name: "setThinkingLevel", scope: "session", description: "Set the thinking level", paramsSchema: objectSchema({ level: STRING }, ["level"]), queue: "serialized" },
  { name: "cycleThinkingLevel", scope: "session", description: "Cycle the thinking level", queue: "serialized" },
  { name: "setSteeringMode", scope: "session", description: "Set steering queue delivery mode", paramsSchema: objectSchema({ mode: QUEUE_MODE }), queue: "immediate" },
  { name: "setFollowUpMode", scope: "session", description: "Set follow-up queue delivery mode", paramsSchema: objectSchema({ mode: QUEUE_MODE }), queue: "immediate" },
  { name: "clearQueue", scope: "session", description: "Clear pending steering and follow-up queues", queue: "immediate" },
  { name: "compact", scope: "session", description: "Start Pi compaction", paramsSchema: objectSchema({ customInstructions: STRING }), queue: "serialized", cancellable: true },
  { name: "abortCompaction", scope: "session", description: "Abort active compaction", queue: "immediate" },
  { name: "abortBranchSummary", scope: "session", description: "Abort active branch summary", queue: "immediate" },
  { name: "setAutoCompaction", scope: "session", description: "Toggle automatic compaction", paramsSchema: objectSchema({ enabled: BOOLEAN }, ["enabled"]), queue: "serialized" },
  { name: "setAutoRetry", scope: "session", description: "Toggle automatic retry", paramsSchema: objectSchema({ enabled: BOOLEAN }, ["enabled"]), queue: "serialized" },
  { name: "abortRetry", scope: "session", description: "Abort active retry", queue: "immediate" },
  { name: "bash", scope: "session", description: "Run a bash command through the Pi runtime", paramsSchema: objectSchema({ command: STRING, excludeFromContext: BOOLEAN }, ["command"]), queue: "serialized", cancellable: true },
  { name: "abortBash", scope: "session", description: "Abort active bash execution", queue: "immediate" },
  { name: "setActiveTools", scope: "session", description: "Set active Pi tools", paramsSchema: objectSchema({ toolNames: STRING_ARRAY }), queue: "serialized" },
  { name: "invokeTool", scope: "session", source: "pi-extension", description: "Invoke a registered Pi tool by name", paramsSchema: objectSchema({ name: STRING, arguments: objectSchema({}, [], true) }, ["name"]), queue: "serialized" },
  { name: "invokeCommand", scope: "session", source: "pi-extension", description: "Invoke a registered Pi slash command by name", paramsSchema: objectSchema({ name: STRING, args: STRING }, ["name"]), queue: "serialized" },
  { name: "navigateTree", scope: "session", description: "Navigate the Pi session tree", paramsSchema: objectSchema({ entryId: STRING, summarize: BOOLEAN, customInstructions: STRING, replaceInstructions: BOOLEAN, label: STRING }, ["entryId"]), queue: "serialized", replacement: true, cancellable: true },
  { name: "setLabel", scope: "session", description: "Set an entry label", paramsSchema: objectSchema({ entryId: STRING, label: STRING }, ["entryId"]), queue: "serialized" },
  { name: "sendCustomMessage", scope: "session", description: "Send a custom Pi message", paramsSchema: objectSchema({ customType: STRING, content: { type: "array", items: { anyOf: [objectSchema({ type: { const: "text" }, text: STRING }, ["type", "text"]), IMAGE_INPUT] } }, display: BOOLEAN, details: ANY_JSON, triggerTurn: BOOLEAN, deliverAs: { enum: ["steer", "followUp", "nextTurn"] } }, ["customType", "content", "display"]), queue: "serialized" },
  { name: "appendCustomEntry", scope: "session", description: "Append a custom Pi entry", paramsSchema: objectSchema({ customType: STRING, data: ANY_JSON }, ["customType"]), queue: "serialized" },
  { name: "exportHtml", scope: "session", description: "Export the session as HTML", paramsSchema: OUTPUT_PATH_PARAMS, queue: "serialized" },
  { name: "exportJsonl", scope: "session", description: "Export the session as JSONL", paramsSchema: OUTPUT_PATH_PARAMS, queue: "serialized" },
  { name: "waitForIdle", scope: "session", description: "Wait until the Pi runtime is idle", queue: "serialized" },
  { name: "reload", scope: "session", description: "Reload Pi runtime resources", queue: "serialized" },
  { name: "respondExtensionUi", scope: "session", description: "Respond to a pending Pi extension UI request", paramsSchema: objectSchema({ requestId: STRING, response: objectSchema({}, [], true) }, ["requestId"]), queue: "immediate" },
  { name: "setExtensionEditorState", scope: "session", description: "Set Pi extension editor state", paramsSchema: objectSchema({ text: STRING }, ["text"]), queue: "immediate" },
  { name: "state.get", scope: "session", description: "Read current Pi session state", queue: "immediate", idempotent: true },
  { name: "entries.get", scope: "session", description: "Read a page of Pi session entries", paramsSchema: pageParams(), queue: "immediate", idempotent: true },
  { name: "branch.get", scope: "session", description: "Read a page of the active Pi branch", paramsSchema: pageParams(), queue: "immediate", idempotent: true },
  { name: "tree.get", scope: "session", description: "Read the Pi session tree", queue: "immediate", idempotent: true },
  { name: "registry.get", scope: "session", description: "Read runtime tools, commands, extensions, and handlers", queue: "immediate", idempotent: true },
  { name: "skills.list", scope: "session", description: "List loaded Pi skills", queue: "immediate", idempotent: true },
  { name: "prompts.list", scope: "session", description: "List loaded Pi prompt templates", queue: "immediate", idempotent: true },
  { name: "attachment.get", scope: "session", description: "Read an attachment from a Pi entry", paramsSchema: objectSchema({ entryId: STRING, blockIndex: { type: "integer", minimum: 0 } }, ["entryId", "blockIndex"]), queue: "immediate", idempotent: true },
  { name: "session.list", scope: "global", description: "List Pi sessions for a workspace", paramsSchema: CWD_PARAMS, queue: "immediate", idempotent: true },
  { name: "session.listAll", scope: "global", description: "List all Pi sessions", queue: "immediate", idempotent: true },
  { name: "session.create", scope: "global", description: "Create a Pi session without opening an agent runtime", paramsSchema: CWD_PARAMS, queue: "serialized" },
  { name: "session.preview", scope: "global", description: "Read a Pi session without opening an agent runtime", paramsSchema: SESSION_PREVIEW_PARAMS, queue: "immediate", idempotent: true },
  { name: "session.delete", scope: "global", description: "Delete a Pi session file", paramsSchema: objectSchema({ cwd: STRING, sessionFile: STRING }, ["cwd", "sessionFile"]), queue: "serialized" },
  { name: "models.list", scope: "global", description: "List Pi models", queue: "immediate", idempotent: true },
  { name: "settings.get", scope: "global", description: "Read Pi settings for a workspace", paramsSchema: CWD_PARAMS, queue: "immediate", idempotent: true },
  { name: "settings.patch", scope: "global", description: "Patch Pi settings for a workspace", paramsSchema: objectSchema({ cwd: STRING, patch: objectSchema({}, [], true) }, ["cwd"]), queue: "serialized" },
  { name: "trust.get", scope: "global", description: "Read Pi project trust state", paramsSchema: CWD_PARAMS, queue: "immediate", idempotent: true },
  { name: "trust.set", scope: "global", description: "Set Pi project trust state", paramsSchema: objectSchema({ cwd: STRING, decision: nullable(BOOLEAN) }, ["cwd", "decision"]), queue: "serialized" },
  { name: "providers.list", scope: "global", description: "List Pi providers", queue: "immediate", idempotent: true },
  { name: "providers.startAuth", scope: "global", description: "Start provider authentication", paramsSchema: objectSchema({ providerId: STRING, authType: { enum: ["api_key", "oauth"] } }, ["providerId"]), queue: "serialized" },
  { name: "providers.respondAuth", scope: "global", description: "Respond to provider authentication prompt", paramsSchema: objectSchema({ flowId: STRING, promptId: STRING, value: STRING }, ["flowId", "promptId", "value"]), queue: "immediate" },
  { name: "providers.cancelAuth", scope: "global", description: "Cancel provider authentication", paramsSchema: objectSchema({ flowId: STRING }, ["flowId"]), queue: "immediate" },
  { name: "providers.logout", scope: "global", description: "Log out from a provider", paramsSchema: objectSchema({ providerId: STRING }, ["providerId"]), queue: "serialized" },
  { name: "modelRuntime.inspect", scope: "global", description: "Inspect the Pi model runtime", queue: "immediate", idempotent: true },
  { name: "modelRuntime.setApiKey", scope: "global", description: "Set a runtime provider API key", paramsSchema: objectSchema({ providerId: STRING, apiKey: STRING }, ["providerId", "apiKey"]), queue: "serialized" },
  { name: "modelRuntime.removeApiKey", scope: "global", description: "Remove a runtime provider API key", paramsSchema: objectSchema({ providerId: STRING }, ["providerId"]), queue: "serialized" },
  { name: "modelRuntime.reload", scope: "global", description: "Reload model runtime config", queue: "serialized" },
  { name: "modelRuntime.refresh", scope: "global", description: "Refresh model runtime state", paramsSchema: objectSchema({ options: objectSchema({}, [], true) }), queue: "serialized" },
  { name: "packages.list", scope: "global", description: "List configured Pi packages", paramsSchema: CWD_PARAMS, queue: "immediate", idempotent: true },
  { name: "packages.manage", scope: "global", description: "Install, remove, or update Pi packages", paramsSchema: objectSchema({ cwd: STRING, commandId: STRING, action: { enum: ["install", "remove", "update"] }, source: STRING, local: BOOLEAN, persist: BOOLEAN }, ["cwd", "commandId"]), queue: "serialized" },
  { name: "packages.resolve", scope: "global", description: "Resolve Pi packages for a workspace", paramsSchema: objectSchema({ cwd: STRING, missingAction: { enum: ["install", "skip", "error"] } }, ["cwd"]), queue: "serialized" },
  { name: "packages.resolveSources", scope: "global", description: "Resolve explicit Pi package sources", paramsSchema: objectSchema({ cwd: STRING, sources: STRING_ARRAY, local: BOOLEAN, temporary: BOOLEAN }, ["cwd", "sources"]), queue: "serialized" },
  { name: "packages.changeSource", scope: "global", description: "Add or remove a Pi package source", paramsSchema: objectSchema({ cwd: STRING, source: STRING, operation: { enum: ["add", "remove"] }, local: BOOLEAN }, ["cwd", "source"]), queue: "serialized" },
  { name: "packages.installedPath", scope: "global", description: "Read installed Pi package path", paramsSchema: objectSchema({ cwd: STRING, source: STRING, scope: { enum: ["user", "project"] } }, ["cwd", "source"]), queue: "immediate", idempotent: true },
  { name: "packages.checkUpdates", scope: "global", description: "Check Pi package updates", paramsSchema: CWD_PARAMS, queue: "serialized" },
] as const satisfies readonly PiCommandSpec[]

/**
 * 会话命令 → SessionRuntime 方法的绑定清单（PiUI 驱动层对 Pi 的能力接缝）。
 * 这是"不手写第二份镜像"的关键：每条会话命令声明它驱动哪个驱动方法，
 * worker 启动时校验 RealPiSession 与 MockPiSession 都实现了它——加了命令
 * 忘实现（或反过来）会启动即炸，不允许静默漂移。
 */
export const RUNTIME_TARGETS = {
  prompt: "prompt",
  steer: "steer",
  followUp: "followUp",
  sendUserMessage: "sendUserMessage",
  abort: "abort",
  newSession: "newSession",
  switchSession: "switchSession",
  fork: "fork",
  importSession: "importSession",
  setSessionName: "setSessionName",
  setModel: "setModel",
  cycleModel: "cycleModel",
  setScopedModels: "setScopedModels",
  setThinkingLevel: "setThinkingLevel",
  cycleThinkingLevel: "cycleThinkingLevel",
  setSteeringMode: "setSteeringMode",
  setFollowUpMode: "setFollowUpMode",
  clearQueue: "clearQueue",
  compact: "compact",
  abortCompaction: "abortCompaction",
  abortBranchSummary: "abortBranchSummary",
  setAutoCompaction: "setAutoCompaction",
  setAutoRetry: "setAutoRetry",
  abortRetry: "abortRetry",
  bash: "bash",
  abortBash: "abortBash",
  setActiveTools: "setActiveTools",
  invokeTool: "invokeTool",
  invokeCommand: "invokeCommand",
  navigateTree: "navigateTree",
  setLabel: "setLabel",
  sendCustomMessage: "sendCustomMessage",
  appendCustomEntry: "appendCustomEntry",
  exportHtml: "exportHtml",
  exportJsonl: "exportJsonl",
  waitForIdle: "waitForIdle",
  reload: "reload",
  respondExtensionUi: "respondExtensionUi",
  setExtensionEditorState: "setExtensionEditorState",
  "state.get": "getState",
  "entries.get": "getEntriesPage",
  "branch.get": "getBranchPage",
  "tree.get": "getTree",
  "registry.get": "getRegistry",
  "skills.list": "listSkills",
  "prompts.list": "listPrompts",
  "attachment.get": "getAttachment",
} as const

export type RuntimeTarget = (typeof RUNTIME_TARGETS)[keyof typeof RUNTIME_TARGETS]

export type PiCommandName = (typeof PI_COMMAND_SPECS)[number]["name"]

export type PiPageParams = {
  cursor?: string | null
  limit?: number
  maxBytes?: number
}

/**
 * 每条命令的 TS 入参类型——与上面的 paramsSchema 住在同一文件，
 * 改 schema 时类型就在旁边，漂移一眼可见。core 38 条的参数类型
 * 复用 commands.ts 的 CoreCommandParams。
 */
export type PiCommandParams = CoreCommandParams & {
  "state.get": Record<string, never>
  "entries.get": PiPageParams
  "branch.get": PiPageParams
  "tree.get": Record<string, never>
  "registry.get": Record<string, never>
  "skills.list": Record<string, never>
  "prompts.list": Record<string, never>
  "attachment.get": { entryId: string; blockIndex: number }
  "session.list": { cwd: string }
  "session.listAll": Record<string, never>
  "session.create": { cwd: string }
  "session.preview": { sessionId: string } & PiPageParams
  "session.delete": { cwd: string; sessionFile: string }
  "models.list": Record<string, never>
  "settings.get": { cwd: string }
  "settings.patch": { cwd: string; patch: JsonObject }
  "trust.get": { cwd: string }
  "trust.set": { cwd: string; decision: boolean | null }
  "providers.list": Record<string, never>
  "providers.startAuth": { providerId: string; authType?: "api_key" | "oauth" }
  "providers.respondAuth": { flowId: string; promptId: string; value: string }
  "providers.cancelAuth": { flowId: string }
  "providers.logout": { providerId: string }
  "modelRuntime.inspect": Record<string, never>
  "modelRuntime.setApiKey": { providerId: string; apiKey: string }
  "modelRuntime.removeApiKey": { providerId: string }
  "modelRuntime.reload": Record<string, never>
  "modelRuntime.refresh": { options?: JsonObject }
  "packages.list": { cwd: string }
  "packages.manage": { cwd: string; commandId: string; action?: "install" | "remove" | "update"; source?: string; local?: boolean; persist?: boolean }
  "packages.resolve": { cwd: string; missingAction?: "install" | "skip" | "error" }
  "packages.resolveSources": { cwd: string; sources: string[]; local?: boolean; temporary?: boolean }
  "packages.changeSource": { cwd: string; source: string; operation?: "add" | "remove"; local?: boolean }
  "packages.installedPath": { cwd: string; source: string; scope?: "user" | "project" }
  "packages.checkUpdates": { cwd: string }
}

/** server 适配层额外暴露的全局命令（不经 worker 命令表） */
export type PiServerGlobalCommandName = "session.open" | "session.attached" | "registry.describe"
export type PiGlobalCommandName = PiCommandName | PiServerGlobalCommandName

/** 命令名对应的入参类型；不在表里的 server 命令回退到通用 JsonObject */
export type PiParamsFor<K extends string> = K extends keyof PiCommandParams ? PiCommandParams[K] : JsonObject

// 编译期防漂移：参数映射表的键必须与声明表的命令名完全一致，
// 加了命令忘了补类型（或反过来）会直接 typecheck 失败。
type Assert<Condition extends true> = Condition
type _PiParamsCoverAllSpecs = Assert<PiCommandName extends keyof PiCommandParams ? true : false>
type _PiParamsHaveNoExtras = Assert<Exclude<keyof PiCommandParams, PiCommandName> extends never ? true : false>

// 编译期防漂移：RUNTIME_TARGETS 的键必须是已声明的命令名（不能指向不存在的命令）。
type _RuntimeTargetsNameKnownCommands = Assert<keyof typeof RUNTIME_TARGETS extends PiCommandName ? true : false>

// 运行时防漂移（worker 启动时再校验一次）：每条 session 作用域命令都必须有 runtime
// target，且 target 只指向 session 命令（global 命令走 catalog/auth/packages）。
export function assertSessionCommandsTargeted(): string[] {
  const missing: string[] = []
  for (const spec of PI_COMMAND_SPECS) {
    if (spec.scope !== "session") continue
    if (!(spec.name in RUNTIME_TARGETS)) missing.push(spec.name)
  }
  return missing
}
