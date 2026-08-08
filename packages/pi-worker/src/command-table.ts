import { PI_COMMAND_SPECS, piSpecToCapability, type JsonObject, type JsonValue, type PiCapability, type PiCapabilityScope, type RegistrySnapshot } from "@piui/protocol"
import type { CatalogProvider, SessionRuntime } from "./runtime.js"
import * as P from "./params.js"

export interface ProviderAuthGateway {
  listProviders(): Promise<JsonValue>
  listModels(): Promise<JsonValue>
  start(providerId: string, authType: "api_key" | "oauth"): Promise<JsonValue>
  respond(flowId: string, promptId: string, value: string): void
  cancel(flowId: string): void
  logout(providerId: string): Promise<void>
  inspect(): Promise<JsonValue>
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>
  removeRuntimeApiKey(providerId: string): Promise<void>
  reloadConfig(): Promise<void>
  refresh(options?: JsonObject): Promise<JsonValue>
}

export interface PackagesGateway {
  list(cwd: string): Promise<JsonValue> | JsonValue
  manage(
    cwd: string,
    commandId: string,
    action: "install" | "remove" | "update",
    source?: string,
    local?: boolean,
    persist?: boolean,
    onProgress?: (event: JsonObject) => void,
  ): Promise<JsonValue>
  resolve(cwd: string, missingAction?: "install" | "skip" | "error"): Promise<JsonValue>
  resolveSources(cwd: string, sources: string[], local?: boolean, temporary?: boolean): Promise<JsonValue>
  changeSource(cwd: string, source: string, operation: "add" | "remove", local?: boolean): Promise<JsonValue>
  installedPath(cwd: string, source: string, scope: "user" | "project"): Promise<JsonValue> | JsonValue
  checkUpdates(cwd: string): Promise<JsonValue>
}

export interface CommandContext {
  runtime: SessionRuntime | undefined
  driver?: "pi" | "mock"
  catalog: CatalogProvider
  auth: ProviderAuthGateway
  packages: PackagesGateway
  requireRuntime(): SessionRuntime
}

export type CommandHandler = (ctx: CommandContext, params: JsonObject) => Promise<JsonValue | undefined | void>

const QUEUE_MODES = ["all", "one-at-a-time"] as const
const REPLACEMENT_OPS = { fork: true, newSession: true, switchSession: true, importSession: true }

const COMMAND_IMPLEMENTATIONS: Record<string, CommandHandler> = {
  prompt: async (ctx, p) => {
    await ctx.requireRuntime().prompt(P.reqString(p, "text"), P.optImages(p), {
      expandPromptTemplates: P.optBoolean(p, "expandPromptTemplates"),
      streamingBehavior: P.optEnum(p, "streamingBehavior", ["steer", "followUp"] as const),
    })
  },
  steer: async (ctx, p) => {
    await ctx.requireRuntime().steer(P.reqString(p, "text"), P.optImages(p))
  },
  followUp: async (ctx, p) => {
    await ctx.requireRuntime().followUp(P.reqString(p, "text"), P.optImages(p))
  },
  sendUserMessage: async (ctx, p) => {
    await ctx.requireRuntime().sendUserMessage(
      P.reqString(p, "text"),
      P.optImages(p),
      P.optEnum(p, "deliverAs", ["steer", "followUp"] as const),
    )
  },
  abort: async (ctx) => ctx.requireRuntime().abort(),

  newSession: async (ctx, p) => ctx.requireRuntime().newSession(P.optString(p, "parentSession")),
  switchSession: async (ctx, p) =>
    ctx.requireRuntime().switchSession(P.reqString(p, "sessionPath"), P.optString(p, "cwdOverride")),
  fork: async (ctx, p) =>
    ctx.requireRuntime().fork(P.reqString(p, "entryId"), P.optEnum(p, "position", ["before", "at"] as const) ?? "at"),
  importSession: async (ctx, p) =>
    ctx.requireRuntime().importSession(P.reqString(p, "inputPath"), P.optString(p, "cwdOverride")),
  setSessionName: async (ctx, p) => {
    await ctx.requireRuntime().setSessionName(P.reqString(p, "name"))
  },

  setModel: async (ctx, p) => {
    await ctx.requireRuntime().setModel(P.reqString(p, "provider"), P.reqString(p, "modelId"))
  },
  cycleModel: async (ctx, p) => {
    await ctx.requireRuntime().cycleModel(P.optEnum(p, "direction", ["forward", "backward"] as const))
  },
  setScopedModels: async (ctx, p) => ctx.requireRuntime().setScopedModels(P.optStringArray(p, "patterns") ?? []),
  setThinkingLevel: async (ctx, p) => {
    await ctx.requireRuntime().setThinkingLevel(P.reqString(p, "level"))
  },
  cycleThinkingLevel: async (ctx) => ctx.requireRuntime().cycleThinkingLevel(),

  setSteeringMode: async (ctx, p) => {
    await ctx.requireRuntime().setSteeringMode(P.optEnum(p, "mode", QUEUE_MODES) ?? "all")
  },
  setFollowUpMode: async (ctx, p) => {
    await ctx.requireRuntime().setFollowUpMode(P.optEnum(p, "mode", QUEUE_MODES) ?? "one-at-a-time")
  },
  clearQueue: async (ctx) => ctx.requireRuntime().clearQueue(),

  compact: async (ctx, p) => ctx.requireRuntime().compact(P.optString(p, "customInstructions")),
  abortCompaction: async (ctx) => ctx.requireRuntime().abortCompaction(),
  abortBranchSummary: async (ctx) => ctx.requireRuntime().abortBranchSummary(),
  setAutoCompaction: async (ctx, p) => {
    await ctx.requireRuntime().setAutoCompaction(P.reqBoolean(p, "enabled"))
  },
  setAutoRetry: async (ctx, p) => {
    await ctx.requireRuntime().setAutoRetry(P.reqBoolean(p, "enabled"))
  },
  abortRetry: async (ctx) => ctx.requireRuntime().abortRetry(),

  bash: async (ctx, p) =>
    ctx.requireRuntime().bash(P.reqString(p, "command"), P.optBoolean(p, "excludeFromContext"), P.optString(p, "clientId")),
  abortBash: async (ctx) => ctx.requireRuntime().abortBash(),

  setActiveTools: async (ctx, p) => {
    await ctx.requireRuntime().setActiveTools(P.optStringArray(p, "toolNames") ?? [])
  },
  invokeTool: async (ctx, p) =>
    ctx.requireRuntime().invokeTool(P.reqString(p, "name"), P.optObject(p, "arguments")),
  invokeCommand: async (ctx, p) =>
    ctx.requireRuntime().invokeCommand(P.reqString(p, "name"), P.optString(p, "args")),

  navigateTree: async (ctx, p) =>
    ctx.requireRuntime().navigateTree(P.reqString(p, "entryId"), {
      summarize: P.optBoolean(p, "summarize"),
      customInstructions: P.optString(p, "customInstructions"),
      replaceInstructions: P.optBoolean(p, "replaceInstructions"),
      label: P.optString(p, "label"),
    }),
  setLabel: async (ctx, p) => {
    await ctx.requireRuntime().setLabel(P.reqString(p, "entryId"), P.optString(p, "label"))
  },

  sendCustomMessage: async (ctx, p) => {
    const content = p.content
    if (!Array.isArray(content)) throw Object.assign(new Error("params.content must be an array"), { code: "INVALID_REQUEST" })
    await ctx.requireRuntime().sendCustomMessage(P.reqString(p, "customType"), content as never, {
      display: P.reqBoolean(p, "display"),
      details: P.optValue(p, "details"),
      triggerTurn: P.optBoolean(p, "triggerTurn"),
      deliverAs: P.optEnum(p, "deliverAs", ["steer", "followUp", "nextTurn"] as const),
    })
  },
  appendCustomEntry: async (ctx, p) => {
    await ctx.requireRuntime().appendCustomEntry(P.reqString(p, "customType"), P.optValue(p, "data"))
  },

  exportHtml: async (ctx, p) => ctx.requireRuntime().exportHtml(P.reqString(p, "outputPath")),
  exportJsonl: async (ctx, p) => ctx.requireRuntime().exportJsonl(P.reqString(p, "outputPath")),

  waitForIdle: async (ctx) => ctx.requireRuntime().waitForIdle(),
  reload: async (ctx) => ctx.requireRuntime().reload(),
  respondExtensionUi: async (ctx, p) => {
    const response = P.optObject(p, "response") ?? {}
    const accepted = await ctx.requireRuntime().respondExtensionUi(P.reqString(p, "requestId"), response)
    if (!accepted) {
      throw Object.assign(new Error("extension UI request is no longer pending"), { code: "EXTENSION_UI_CANCELLED" })
    }
  },
  setExtensionEditorState: async (ctx, p) => {
    await ctx.requireRuntime().setExtensionEditorState(P.reqStringAllowEmpty(p, "text"))
  },

  "state.get": async (ctx) => ctx.requireRuntime().getState(),
  "entries.get": async (ctx, p) =>
    ctx.requireRuntime().getEntriesPage(
      P.optString(p, "cursor"),
      P.optPositiveInteger(p, "limit") ?? 200,
      P.optPositiveInteger(p, "maxBytes") ?? 4 * 1024 * 1024,
    ),
  "branch.get": async (ctx, p) =>
    ctx.requireRuntime().getBranchPage(
      P.optString(p, "cursor"),
      P.optPositiveInteger(p, "limit") ?? 200,
      P.optPositiveInteger(p, "maxBytes") ?? 4 * 1024 * 1024,
    ),
  "tree.get": async (ctx) => ctx.requireRuntime().getTree(),
  "registry.get": async (ctx) => ctx.requireRuntime().getRegistry(),
  "skills.list": async (ctx) => ctx.requireRuntime().listSkills(),
  "prompts.list": async (ctx) => ctx.requireRuntime().listPrompts(),
  "agentsFiles.list": async (ctx) => ctx.requireRuntime().listAgentsFiles(),
  "attachment.get": async (ctx, p) =>
    ctx.requireRuntime().getAttachment(P.reqString(p, "entryId"), P.reqNonNegativeInteger(p, "blockIndex")),

  "session.list": async (ctx, p) => ctx.catalog.listSessions(P.reqString(p, "cwd")),
  "session.listAll": async (ctx) => ctx.catalog.listAllSessions(),
  "session.create": async (ctx, p) => ctx.catalog.createSession(P.reqString(p, "cwd")),
  "session.preview": async (ctx, p) => ctx.catalog.previewSessionById(
    P.reqString(p, "sessionId"),
    { cursor: P.optString(p, "cursor"), limit: P.optNumber(p, "limit"), maxBytes: P.optNumber(p, "maxBytes") },
  ),
  "session.delete": async (ctx, p) => {
    await ctx.catalog.deleteSession(P.reqString(p, "cwd"), P.reqString(p, "sessionFile"))
  },
  // Model visibility and provider credentials must come from the same
  // runtime. The catalog creates a fresh credential-blind runtime, which
  // loses temporary keys set through the provider auth UI after a refresh.
  "models.list": async (ctx) => ctx.driver === "mock" ? ctx.catalog.listModels() : ctx.auth.listModels(),
  "settings.get": async (ctx, p) => ctx.catalog.getSettings(P.reqString(p, "cwd")),
  "settings.patch": async (ctx, p) =>
    ctx.catalog.patchSettings(P.reqString(p, "cwd"), P.optObject(p, "patch") ?? {}),
  "trust.get": async (ctx, p) => ctx.catalog.getProjectTrust(P.reqString(p, "cwd")),
  "trust.set": async (ctx, p) => {
    const decision = p.decision
    if (decision !== null && typeof decision !== "boolean") {
      throw Object.assign(new Error("params.decision must be a boolean or null"), { code: "INVALID_REQUEST" })
    }
    return ctx.catalog.setProjectTrust(P.reqString(p, "cwd"), decision)
  },

  "providers.list": async (ctx) => ctx.auth.listProviders(),
  "providers.startAuth": async (ctx, p) =>
    ctx.auth.start(P.reqString(p, "providerId"), P.optEnum(p, "authType", ["api_key", "oauth"] as const) ?? "api_key"),
  "providers.respondAuth": async (ctx, p) => {
    ctx.auth.respond(P.reqString(p, "flowId"), P.reqString(p, "promptId"), P.reqString(p, "value"))
  },
  "providers.cancelAuth": async (ctx, p) => {
    ctx.auth.cancel(P.reqString(p, "flowId"))
  },
  "providers.logout": async (ctx, p) => {
    await ctx.auth.logout(P.reqString(p, "providerId"))
  },
  "modelRuntime.inspect": async (ctx) => ctx.auth.inspect(),
  "modelRuntime.setApiKey": async (ctx, p) => {
    await ctx.auth.setRuntimeApiKey(P.reqString(p, "providerId"), P.reqString(p, "apiKey"))
  },
  "modelRuntime.removeApiKey": async (ctx, p) => {
    await ctx.auth.removeRuntimeApiKey(P.reqString(p, "providerId"))
  },
  "modelRuntime.reload": async (ctx) => ctx.auth.reloadConfig(),
  "modelRuntime.refresh": async (ctx, p) => ctx.auth.refresh(P.optObject(p, "options")),

  "packages.list": async (ctx, p) => ctx.packages.list(P.reqString(p, "cwd")),
  "packages.manage": async (ctx, p) =>
    ctx.packages.manage(
      P.reqString(p, "cwd"),
      P.reqString(p, "commandId"),
      P.optEnum(p, "action", ["install", "remove", "update"] as const) ?? "install",
      P.optString(p, "source"),
      P.optBoolean(p, "local"),
      P.optBoolean(p, "persist"),
    ),
  "packages.resolve": async (ctx, p) =>
    ctx.packages.resolve(P.reqString(p, "cwd"), P.optEnum(p, "missingAction", ["install", "skip", "error"] as const)),
  "packages.resolveSources": async (ctx, p) =>
    ctx.packages.resolveSources(
      P.reqString(p, "cwd"),
      P.optStringArray(p, "sources") ?? [],
      P.optBoolean(p, "local"),
      P.optBoolean(p, "temporary"),
    ),
  "packages.changeSource": async (ctx, p) =>
    ctx.packages.changeSource(
      P.reqString(p, "cwd"),
      P.reqString(p, "source"),
      P.optEnum(p, "operation", ["add", "remove"] as const) ?? "add",
      P.optBoolean(p, "local"),
    ),
  "packages.installedPath": async (ctx, p) =>
    ctx.packages.installedPath(
      P.reqString(p, "cwd"),
      P.reqString(p, "source"),
      P.optEnum(p, "scope", ["user", "project"] as const) ?? "user",
    ),
  "packages.checkUpdates": async (ctx, p) => ctx.packages.checkUpdates(P.reqString(p, "cwd")),
}

export function isReplacementCommand(type: string): boolean {
  return type in REPLACEMENT_OPS
}

/**
 * 扩展命令/工具的按名路由：唯一事实源是 Pi 运行时自己的注册表
 * （loader.getExtensions 的结果），PiUI 不做第二份镜像。静态表未命中的
 * 命令先在这里查，注册过就原生分发（invokeCommand / invokeTool）。
 */
export function resolveExtensionTarget(registry: RegistrySnapshot, type: string): "command" | "tool" | undefined {
  if (registry.commands.some(command => command.name === type)) return "command"
  if (registry.tools.some(tool => tool.name === type)) return "tool"
  return undefined
}

export function listCommandTypes(): string[] {
  return Object.keys(COMMAND_HANDLERS)
}

export function getCommandCapability(name: string): PiCapability | undefined {
  const found = COMMAND_REGISTRY.find(item => item.capability.name === name)
  if (!found) return undefined
  return { ...found.capability }
}

export function listCommandCapabilities(scope?: PiCapabilityScope): PiCapability[] {
  return COMMAND_REGISTRY
    .filter(item => !scope || item.capability.scope === scope)
    .map(item => ({ ...item.capability }))
}

type RegisteredPiCapability = {
  capability: PiCapability
  handler: CommandHandler
}

/**
 * 元数据（名字/scope/queue/schema/flags）的唯一来源是 @piui/protocol 的
 * PI_COMMAND_SPECS；这里只绑定 handler。声明缺 handler 或 handler 没注册，
 * 都在 worker 启动时直接炸出来，不允许静默漂移。
 */
const COMMAND_REGISTRY: RegisteredPiCapability[] = PI_COMMAND_SPECS.map(spec => {
  const handler = COMMAND_IMPLEMENTATIONS[spec.name]
  if (!handler) throw new Error(`missing command implementation: ${spec.name}`)
  return { capability: piSpecToCapability(spec), handler }
})

for (const name of Object.keys(COMMAND_IMPLEMENTATIONS)) {
  if (!PI_COMMAND_SPECS.some(spec => spec.name === name)) {
    throw new Error(`unregistered command implementation: ${name}`)
  }
}

export const COMMAND_HANDLERS: Record<string, CommandHandler> = Object.fromEntries(
  COMMAND_REGISTRY.map(item => [item.capability.name, item.handler]),
)
