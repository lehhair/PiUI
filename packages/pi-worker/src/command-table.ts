import type { JsonObject, JsonValue, PiCapability, PiCapabilityScope } from "@piui/protocol"
import type { CatalogProvider, SessionRuntime } from "./runtime.js"
import * as P from "./params.js"

export interface ProviderAuthGateway {
  listProviders(): Promise<JsonValue>
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
  ): Promise<JsonValue>
  resolve(cwd: string, missingAction?: "install" | "skip" | "error"): Promise<JsonValue>
  resolveSources(cwd: string, sources: string[], local?: boolean, temporary?: boolean): Promise<JsonValue>
  changeSource(cwd: string, source: string, operation: "add" | "remove", local?: boolean): Promise<JsonValue>
  installedPath(cwd: string, source: string, scope: "user" | "project"): Promise<JsonValue> | JsonValue
  checkUpdates(cwd: string): Promise<JsonValue>
}

export interface CommandContext {
  runtime: SessionRuntime | undefined
  catalog: CatalogProvider
  auth: ProviderAuthGateway
  packages: PackagesGateway
  requireRuntime(): SessionRuntime
}

export type CommandHandler = (ctx: CommandContext, params: JsonObject) => Promise<JsonValue | undefined | void>

const QUEUE_MODES = ["all", "one-at-a-time"] as const
const REPLACEMENT_OPS = { fork: true, clone: true, newSession: true, switchSession: true, importSession: true }
const SESSION_QUERY_COMMANDS = new Set([
  "state.get",
  "entries.get",
  "branch.get",
  "tree.get",
  "registry.get",
  "attachment.get",
])

export const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  prompt: async (ctx, p) => {
    await ctx.requireRuntime().prompt(P.reqString(p, "text"), P.optImages(p), {
      expandPromptTemplates: P.optBoolean(p, "expandPromptTemplates"),
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
  clone: async (ctx, p) => ctx.requireRuntime().clone(P.optString(p, "entryId")),
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
    ctx.requireRuntime().bash(P.reqString(p, "command"), P.optBoolean(p, "excludeFromContext")),
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
    await ctx.requireRuntime().setExtensionEditorState(P.reqString(p, "text"))
  },

  "state.get": async (ctx) => ctx.requireRuntime().getState(),
  "entries.get": async (ctx, p) =>
    ctx.requireRuntime().getEntriesPage(
      P.optString(p, "cursor"),
      P.optNumber(p, "limit") ?? 200,
      P.optNumber(p, "maxBytes") ?? 4 * 1024 * 1024,
    ),
  "branch.get": async (ctx, p) =>
    ctx.requireRuntime().getBranchPage(
      P.optString(p, "cursor"),
      P.optNumber(p, "limit") ?? 200,
      P.optNumber(p, "maxBytes") ?? 4 * 1024 * 1024,
    ),
  "tree.get": async (ctx) => ctx.requireRuntime().getTree(),
  "registry.get": async (ctx) => ctx.requireRuntime().getRegistry(),
  "attachment.get": async (ctx, p) =>
    ctx.requireRuntime().getAttachment(P.reqString(p, "entryId"), P.reqNumber(p, "blockIndex")),

  "session.list": async (ctx, p) => ctx.catalog.listSessions(P.reqString(p, "cwd")),
  "session.listAll": async (ctx) => ctx.catalog.listAllSessions(),
  "session.delete": async (ctx, p) => {
    await ctx.catalog.deleteSession(P.reqString(p, "cwd"), P.reqString(p, "sessionFile"))
  },
  "models.list": async (ctx) => ctx.catalog.listModels(),
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

export function listCommandTypes(): string[] {
  return Object.keys(COMMAND_HANDLERS)
}

export function getCommandCapability(name: string): PiCapability | undefined {
  return COMMAND_CAPABILITIES.find(capability => capability.name === name)
}

export function listCommandCapabilities(scope?: PiCapabilityScope): PiCapability[] {
  return COMMAND_CAPABILITIES
    .filter(capability => !scope || capability.scope === scope)
    .map(capability => ({ ...capability }))
}

function commandScope(name: string): PiCapabilityScope {
  if (SESSION_QUERY_COMMANDS.has(name)) return "session"
  if (name.startsWith("session.") || name.startsWith("models.") || name.startsWith("settings.") ||
    name.startsWith("trust.") || name.startsWith("providers.") || name.startsWith("modelRuntime.") ||
    name.startsWith("packages.")) {
    return "global"
  }
  return "session"
}

function commandSource(name: string): PiCapability["source"] {
  if (name === "invokeTool" || name === "invokeCommand") return "pi-extension"
  return "pi-sdk"
}

function commandDescription(name: string): string {
  return DESCRIPTIONS[name] ?? name
}

const DESCRIPTIONS: Record<string, string> = {
  prompt: "Send a user prompt to the current Pi session",
  steer: "Queue steering text for the current Pi session",
  followUp: "Queue a follow-up message for the current Pi session",
  sendUserMessage: "Append and optionally deliver a user message",
  abort: "Abort the current Pi turn",
  newSession: "Create a new Pi session from the current runtime",
  switchSession: "Switch the runtime to another Pi session file",
  fork: "Fork the current Pi session at an entry",
  clone: "Clone the current Pi session",
  importSession: "Import a Pi session file",
  setSessionName: "Set the current Pi session name",
  setModel: "Set provider and model for the current Pi session",
  cycleModel: "Cycle the selected model",
  setScopedModels: "Set scoped model patterns",
  setThinkingLevel: "Set the thinking level",
  cycleThinkingLevel: "Cycle the thinking level",
  setSteeringMode: "Set steering queue delivery mode",
  setFollowUpMode: "Set follow-up queue delivery mode",
  clearQueue: "Clear pending steering and follow-up queues",
  compact: "Start Pi compaction",
  abortCompaction: "Abort active compaction",
  abortBranchSummary: "Abort active branch summary",
  setAutoCompaction: "Toggle automatic compaction",
  setAutoRetry: "Toggle automatic retry",
  abortRetry: "Abort active retry",
  bash: "Run a bash command through the Pi runtime",
  abortBash: "Abort active bash execution",
  setActiveTools: "Set active Pi tools",
  invokeTool: "Invoke a registered Pi tool by name",
  invokeCommand: "Invoke a registered Pi slash command by name",
  navigateTree: "Navigate the Pi session tree",
  setLabel: "Set an entry label",
  sendCustomMessage: "Send a custom Pi message",
  appendCustomEntry: "Append a custom Pi entry",
  exportHtml: "Export the session as HTML",
  exportJsonl: "Export the session as JSONL",
  waitForIdle: "Wait until the Pi runtime is idle",
  reload: "Reload Pi runtime resources",
  respondExtensionUi: "Respond to a pending Pi extension UI request",
  setExtensionEditorState: "Set Pi extension editor state",
  "state.get": "Read current Pi session state",
  "entries.get": "Read a page of Pi session entries",
  "branch.get": "Read a page of the active Pi branch",
  "tree.get": "Read the Pi session tree",
  "registry.get": "Read runtime tools, commands, extensions, and handlers",
  "attachment.get": "Read an attachment from a Pi entry",
  "session.list": "List Pi sessions for a workspace",
  "session.listAll": "List all Pi sessions",
  "session.delete": "Delete a Pi session file",
  "models.list": "List Pi models",
  "settings.get": "Read Pi settings for a workspace",
  "settings.patch": "Patch Pi settings for a workspace",
  "trust.get": "Read Pi project trust state",
  "trust.set": "Set Pi project trust state",
  "providers.list": "List Pi providers",
  "providers.startAuth": "Start provider authentication",
  "providers.respondAuth": "Respond to provider authentication prompt",
  "providers.cancelAuth": "Cancel provider authentication",
  "providers.logout": "Log out from a provider",
  "modelRuntime.inspect": "Inspect the Pi model runtime",
  "modelRuntime.setApiKey": "Set a runtime provider API key",
  "modelRuntime.removeApiKey": "Remove a runtime provider API key",
  "modelRuntime.reload": "Reload model runtime config",
  "modelRuntime.refresh": "Refresh model runtime state",
  "packages.list": "List configured Pi packages",
  "packages.manage": "Install, remove, or update Pi packages",
  "packages.resolve": "Resolve Pi packages for a workspace",
  "packages.resolveSources": "Resolve explicit Pi package sources",
  "packages.changeSource": "Add or remove a Pi package source",
  "packages.installedPath": "Read installed Pi package path",
  "packages.checkUpdates": "Check Pi package updates",
}

function paramsSchema(name: string): JsonObject {
  const required = REQUIRED_PARAMS[name] ?? []
  return {
    type: "object",
    additionalProperties: true,
    required,
    properties: Object.fromEntries(required.map(key => [key, { type: "string" }])),
  }
}

const REQUIRED_PARAMS: Record<string, string[]> = {
  prompt: ["text"],
  steer: ["text"],
  followUp: ["text"],
  sendUserMessage: ["text"],
  switchSession: ["sessionPath"],
  fork: ["entryId"],
  importSession: ["inputPath"],
  setSessionName: ["name"],
  setModel: ["provider", "modelId"],
  setThinkingLevel: ["level"],
  bash: ["command"],
  invokeTool: ["name"],
  invokeCommand: ["name"],
  navigateTree: ["entryId"],
  setLabel: ["entryId"],
  sendCustomMessage: ["customType", "content", "display"],
  exportHtml: ["outputPath"],
  exportJsonl: ["outputPath"],
  respondExtensionUi: ["requestId"],
  setExtensionEditorState: ["text"],
  "attachment.get": ["entryId", "blockIndex"],
  "session.list": ["cwd"],
  "session.delete": ["cwd", "sessionFile"],
  "settings.get": ["cwd"],
  "settings.patch": ["cwd"],
  "trust.get": ["cwd"],
  "trust.set": ["cwd"],
  "providers.startAuth": ["providerId"],
  "providers.respondAuth": ["flowId", "promptId", "value"],
  "providers.cancelAuth": ["flowId"],
  "providers.logout": ["providerId"],
  "modelRuntime.setApiKey": ["providerId", "apiKey"],
  "modelRuntime.removeApiKey": ["providerId"],
  "packages.list": ["cwd"],
  "packages.manage": ["cwd", "commandId"],
  "packages.resolve": ["cwd"],
  "packages.resolveSources": ["cwd"],
  "packages.changeSource": ["cwd", "source"],
  "packages.installedPath": ["cwd", "source"],
  "packages.checkUpdates": ["cwd"],
}

const COMMAND_CAPABILITIES: PiCapability[] = Object.keys(COMMAND_HANDLERS).map(name => {
  const scope = commandScope(name)
  return {
    name,
    scope,
    source: commandSource(name),
    description: commandDescription(name),
    paramsSchema: paramsSchema(name),
    queue: scope === "session" && !SESSION_QUERY_COMMANDS.has(name) ? "serialized" : "immediate",
    replacement: isReplacementCommand(name) || undefined,
  }
})
