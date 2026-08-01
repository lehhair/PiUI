import type { JsonObject, JsonValue, PiCapability, PiCapabilityScope } from "@piui/protocol"
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
    await ctx.requireRuntime().setExtensionEditorState(P.reqStringAllowEmpty(p, "text"))
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
  "skills.list": async (ctx) => ctx.requireRuntime().listSkills(),
  "attachment.get": async (ctx, p) =>
    ctx.requireRuntime().getAttachment(P.reqString(p, "entryId"), P.reqNumber(p, "blockIndex")),

  "session.list": async (ctx, p) => ctx.catalog.listSessions(P.reqString(p, "cwd")),
  "session.listAll": async (ctx) => ctx.catalog.listAllSessions(),
  "session.delete": async (ctx, p) => {
    await ctx.catalog.deleteSession(P.reqString(p, "cwd"), P.reqString(p, "sessionFile"))
  },
  // Model visibility and provider credentials must come from the same
  // runtime. The catalog creates a fresh credential-blind runtime, which
  // loses temporary keys set through the provider auth UI after a refresh.
  "models.list": async (ctx) => ctx.auth.listModels(),
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

type CapabilityOptions = {
  name: string
  scope: PiCapabilityScope
  description?: string
  paramsSchema?: JsonObject
  resultSchema?: JsonObject
  source?: PiCapability["source"]
  queue?: PiCapability["queue"]
  replacement?: boolean
  streaming?: boolean
  cancellable?: boolean
  idempotent?: boolean
  requiresRuntime?: boolean
  requiresTrust?: boolean
  handler: CommandHandler
}

function registerPiCapability({ handler, ...capability }: CapabilityOptions): RegisteredPiCapability {
  return {
    capability: {
      source: "pi-sdk",
      paramsSchema: EMPTY_PARAMS,
      ...capability,
    },
    handler,
  }
}

function command(name: string): CommandHandler {
  const handler = COMMAND_IMPLEMENTATIONS[name]
  if (!handler) throw new Error(`missing command implementation: ${name}`)
  return handler
}

const STRING: JsonObject = { type: "string" }
const BOOLEAN: JsonObject = { type: "boolean" }
const NUMBER: JsonObject = { type: "number" }
const NULL: JsonObject = { type: "null" }
const ANY_JSON: JsonObject = {}
const STRING_ARRAY: JsonObject = { type: "array", items: STRING }
const IMAGE_INPUT: JsonObject = objectSchema({
  type: { const: "image" },
  data: STRING,
  mimeType: STRING,
}, ["type", "data", "mimeType"])
const IMAGES: JsonObject = { type: "array", items: IMAGE_INPUT }
const QUEUE_MODE: JsonObject = { enum: [...QUEUE_MODES] }
const EMPTY_PARAMS = objectSchema({})

function objectSchema(properties: Record<string, JsonObject>, required: string[] = [], additionalProperties = false): JsonObject {
  return { type: "object", additionalProperties, required, properties }
}

function nullable(schema: JsonObject): JsonObject {
  return { anyOf: [schema, NULL] }
}

function pageParams(): JsonObject {
  return objectSchema({
    cursor: nullable(STRING),
    limit: { type: "integer", minimum: 1 },
    maxBytes: { type: "integer", minimum: 1 },
  })
}

const PROMPT_PARAMS = objectSchema({ text: STRING, images: IMAGES, expandPromptTemplates: BOOLEAN, streamingBehavior: { type: "string", enum: ["steer", "followUp"] } }, ["text"])
const TEXT_IMAGES_PARAMS = objectSchema({ text: STRING, images: IMAGES }, ["text"])
const OUTPUT_PATH_PARAMS = objectSchema({ outputPath: STRING }, ["outputPath"])
const CWD_PARAMS = objectSchema({ cwd: STRING }, ["cwd"])

const COMMAND_REGISTRY = [
  registerPiCapability({ name: "prompt", scope: "session", description: "Send a user prompt to the current Pi session", paramsSchema: PROMPT_PARAMS, queue: "serialized", streaming: true, cancellable: true, handler: command("prompt") }),
  registerPiCapability({ name: "steer", scope: "session", description: "Queue steering text for the current Pi session", paramsSchema: TEXT_IMAGES_PARAMS, queue: "immediate", handler: command("steer") }),
  registerPiCapability({ name: "followUp", scope: "session", description: "Queue a follow-up message for the current Pi session", paramsSchema: TEXT_IMAGES_PARAMS, queue: "immediate", handler: command("followUp") }),
  registerPiCapability({ name: "sendUserMessage", scope: "session", description: "Append and optionally deliver a user message", paramsSchema: objectSchema({ text: STRING, images: IMAGES, deliverAs: { enum: ["steer", "followUp"] } }, ["text"]), queue: "immediate", handler: command("sendUserMessage") }),
  registerPiCapability({ name: "abort", scope: "session", description: "Abort the current Pi turn", queue: "immediate", handler: command("abort") }),
  registerPiCapability({ name: "newSession", scope: "session", description: "Create a new Pi session from the current runtime", paramsSchema: objectSchema({ parentSession: STRING }), queue: "serialized", replacement: true, handler: command("newSession") }),
  registerPiCapability({ name: "switchSession", scope: "session", description: "Switch the runtime to another Pi session file", paramsSchema: objectSchema({ sessionPath: STRING, cwdOverride: STRING }, ["sessionPath"]), queue: "serialized", replacement: true, handler: command("switchSession") }),
  registerPiCapability({ name: "fork", scope: "session", description: "Fork the current Pi session at an entry", paramsSchema: objectSchema({ entryId: STRING, position: { enum: ["before", "at"] } }, ["entryId"]), queue: "serialized", replacement: true, handler: command("fork") }),
  registerPiCapability({ name: "importSession", scope: "session", description: "Import a Pi session file", paramsSchema: objectSchema({ inputPath: STRING, cwdOverride: STRING }, ["inputPath"]), queue: "serialized", replacement: true, handler: command("importSession") }),
  registerPiCapability({ name: "setSessionName", scope: "session", description: "Set the current Pi session name", paramsSchema: objectSchema({ name: STRING }, ["name"]), queue: "serialized", handler: command("setSessionName") }),
  registerPiCapability({ name: "setModel", scope: "session", description: "Set provider and model for the current Pi session", paramsSchema: objectSchema({ provider: STRING, modelId: STRING }, ["provider", "modelId"]), queue: "serialized", handler: command("setModel") }),
  registerPiCapability({ name: "cycleModel", scope: "session", description: "Cycle the selected model", paramsSchema: objectSchema({ direction: { enum: ["forward", "backward"] } }), queue: "serialized", handler: command("cycleModel") }),
  registerPiCapability({ name: "setScopedModels", scope: "session", description: "Set scoped model patterns", paramsSchema: objectSchema({ patterns: STRING_ARRAY }), queue: "serialized", handler: command("setScopedModels") }),
  registerPiCapability({ name: "setThinkingLevel", scope: "session", description: "Set the thinking level", paramsSchema: objectSchema({ level: STRING }, ["level"]), queue: "serialized", handler: command("setThinkingLevel") }),
  registerPiCapability({ name: "cycleThinkingLevel", scope: "session", description: "Cycle the thinking level", queue: "serialized", handler: command("cycleThinkingLevel") }),
  registerPiCapability({ name: "setSteeringMode", scope: "session", description: "Set steering queue delivery mode", paramsSchema: objectSchema({ mode: QUEUE_MODE }), queue: "immediate", handler: command("setSteeringMode") }),
  registerPiCapability({ name: "setFollowUpMode", scope: "session", description: "Set follow-up queue delivery mode", paramsSchema: objectSchema({ mode: QUEUE_MODE }), queue: "immediate", handler: command("setFollowUpMode") }),
  registerPiCapability({ name: "clearQueue", scope: "session", description: "Clear pending steering and follow-up queues", queue: "immediate", handler: command("clearQueue") }),
  registerPiCapability({ name: "compact", scope: "session", description: "Start Pi compaction", paramsSchema: objectSchema({ customInstructions: STRING }), queue: "serialized", cancellable: true, handler: command("compact") }),
  registerPiCapability({ name: "abortCompaction", scope: "session", description: "Abort active compaction", queue: "immediate", handler: command("abortCompaction") }),
  registerPiCapability({ name: "abortBranchSummary", scope: "session", description: "Abort active branch summary", queue: "immediate", handler: command("abortBranchSummary") }),
  registerPiCapability({ name: "setAutoCompaction", scope: "session", description: "Toggle automatic compaction", paramsSchema: objectSchema({ enabled: BOOLEAN }, ["enabled"]), queue: "serialized", handler: command("setAutoCompaction") }),
  registerPiCapability({ name: "setAutoRetry", scope: "session", description: "Toggle automatic retry", paramsSchema: objectSchema({ enabled: BOOLEAN }, ["enabled"]), queue: "serialized", handler: command("setAutoRetry") }),
  registerPiCapability({ name: "abortRetry", scope: "session", description: "Abort active retry", queue: "immediate", handler: command("abortRetry") }),
  registerPiCapability({ name: "bash", scope: "session", description: "Run a bash command through the Pi runtime", paramsSchema: objectSchema({ command: STRING, excludeFromContext: BOOLEAN }, ["command"]), queue: "serialized", cancellable: true, handler: command("bash") }),
  registerPiCapability({ name: "abortBash", scope: "session", description: "Abort active bash execution", queue: "immediate", handler: command("abortBash") }),
  registerPiCapability({ name: "setActiveTools", scope: "session", description: "Set active Pi tools", paramsSchema: objectSchema({ toolNames: STRING_ARRAY }), queue: "serialized", handler: command("setActiveTools") }),
  registerPiCapability({ name: "invokeTool", scope: "session", source: "pi-extension", description: "Invoke a registered Pi tool by name", paramsSchema: objectSchema({ name: STRING, arguments: objectSchema({}, [], true) }, ["name"]), queue: "serialized", handler: command("invokeTool") }),
  registerPiCapability({ name: "invokeCommand", scope: "session", source: "pi-extension", description: "Invoke a registered Pi slash command by name", paramsSchema: objectSchema({ name: STRING, args: STRING }, ["name"]), queue: "serialized", handler: command("invokeCommand") }),
  registerPiCapability({ name: "navigateTree", scope: "session", description: "Navigate the Pi session tree", paramsSchema: objectSchema({ entryId: STRING, summarize: BOOLEAN, customInstructions: STRING, replaceInstructions: BOOLEAN, label: STRING }, ["entryId"]), queue: "serialized", replacement: true, cancellable: true, handler: command("navigateTree") }),
  registerPiCapability({ name: "setLabel", scope: "session", description: "Set an entry label", paramsSchema: objectSchema({ entryId: STRING, label: STRING }, ["entryId"]), queue: "serialized", handler: command("setLabel") }),
  registerPiCapability({ name: "sendCustomMessage", scope: "session", description: "Send a custom Pi message", paramsSchema: objectSchema({ customType: STRING, content: { type: "array", items: { anyOf: [objectSchema({ type: { const: "text" }, text: STRING }, ["type", "text"]), IMAGE_INPUT] } }, display: BOOLEAN, details: ANY_JSON, triggerTurn: BOOLEAN, deliverAs: { enum: ["steer", "followUp", "nextTurn"] } }, ["customType", "content", "display"]), queue: "serialized", handler: command("sendCustomMessage") }),
  registerPiCapability({ name: "appendCustomEntry", scope: "session", description: "Append a custom Pi entry", paramsSchema: objectSchema({ customType: STRING, data: ANY_JSON }, ["customType"]), queue: "serialized", handler: command("appendCustomEntry") }),
  registerPiCapability({ name: "exportHtml", scope: "session", description: "Export the session as HTML", paramsSchema: OUTPUT_PATH_PARAMS, queue: "serialized", handler: command("exportHtml") }),
  registerPiCapability({ name: "exportJsonl", scope: "session", description: "Export the session as JSONL", paramsSchema: OUTPUT_PATH_PARAMS, queue: "serialized", handler: command("exportJsonl") }),
  registerPiCapability({ name: "waitForIdle", scope: "session", description: "Wait until the Pi runtime is idle", queue: "serialized", handler: command("waitForIdle") }),
  registerPiCapability({ name: "reload", scope: "session", description: "Reload Pi runtime resources", queue: "serialized", handler: command("reload") }),
  registerPiCapability({ name: "respondExtensionUi", scope: "session", description: "Respond to a pending Pi extension UI request", paramsSchema: objectSchema({ requestId: STRING, response: objectSchema({}, [], true) }, ["requestId"]), queue: "immediate", handler: command("respondExtensionUi") }),
  registerPiCapability({ name: "setExtensionEditorState", scope: "session", description: "Set Pi extension editor state", paramsSchema: objectSchema({ text: STRING }, ["text"]), queue: "immediate", handler: command("setExtensionEditorState") }),
  registerPiCapability({ name: "state.get", scope: "session", description: "Read current Pi session state", queue: "immediate", idempotent: true, handler: command("state.get") }),
  registerPiCapability({ name: "entries.get", scope: "session", description: "Read a page of Pi session entries", paramsSchema: pageParams(), queue: "immediate", idempotent: true, handler: command("entries.get") }),
  registerPiCapability({ name: "branch.get", scope: "session", description: "Read a page of the active Pi branch", paramsSchema: pageParams(), queue: "immediate", idempotent: true, handler: command("branch.get") }),
  registerPiCapability({ name: "tree.get", scope: "session", description: "Read the Pi session tree", queue: "immediate", idempotent: true, handler: command("tree.get") }),
  registerPiCapability({ name: "registry.get", scope: "session", description: "Read runtime tools, commands, extensions, and handlers", queue: "immediate", idempotent: true, handler: command("registry.get") }),
  registerPiCapability({ name: "skills.list", scope: "session", description: "List loaded Pi skills", queue: "immediate", idempotent: true, handler: command("skills.list") }),
  registerPiCapability({ name: "attachment.get", scope: "session", description: "Read an attachment from a Pi entry", paramsSchema: objectSchema({ entryId: STRING, blockIndex: { type: "integer", minimum: 0 } }, ["entryId", "blockIndex"]), queue: "immediate", idempotent: true, handler: command("attachment.get") }),
  registerPiCapability({ name: "session.list", scope: "global", description: "List Pi sessions for a workspace", paramsSchema: CWD_PARAMS, queue: "immediate", idempotent: true, handler: command("session.list") }),
  registerPiCapability({ name: "session.listAll", scope: "global", description: "List all Pi sessions", queue: "immediate", idempotent: true, handler: command("session.listAll") }),
  registerPiCapability({ name: "session.delete", scope: "global", description: "Delete a Pi session file", paramsSchema: objectSchema({ cwd: STRING, sessionFile: STRING }, ["cwd", "sessionFile"]), queue: "serialized", handler: command("session.delete") }),
  registerPiCapability({ name: "models.list", scope: "global", description: "List Pi models", queue: "immediate", idempotent: true, handler: command("models.list") }),
  registerPiCapability({ name: "settings.get", scope: "global", description: "Read Pi settings for a workspace", paramsSchema: CWD_PARAMS, queue: "immediate", idempotent: true, handler: command("settings.get") }),
  registerPiCapability({ name: "settings.patch", scope: "global", description: "Patch Pi settings for a workspace", paramsSchema: objectSchema({ cwd: STRING, patch: objectSchema({}, [], true) }, ["cwd"]), queue: "serialized", handler: command("settings.patch") }),
  registerPiCapability({ name: "trust.get", scope: "global", description: "Read Pi project trust state", paramsSchema: CWD_PARAMS, queue: "immediate", idempotent: true, handler: command("trust.get") }),
  registerPiCapability({ name: "trust.set", scope: "global", description: "Set Pi project trust state", paramsSchema: objectSchema({ cwd: STRING, decision: nullable(BOOLEAN) }, ["cwd"]), queue: "serialized", handler: command("trust.set") }),
  registerPiCapability({ name: "providers.list", scope: "global", description: "List Pi providers", queue: "immediate", idempotent: true, handler: command("providers.list") }),
  registerPiCapability({ name: "providers.startAuth", scope: "global", description: "Start provider authentication", paramsSchema: objectSchema({ providerId: STRING, authType: { enum: ["api_key", "oauth"] } }, ["providerId"]), queue: "serialized", handler: command("providers.startAuth") }),
  registerPiCapability({ name: "providers.respondAuth", scope: "global", description: "Respond to provider authentication prompt", paramsSchema: objectSchema({ flowId: STRING, promptId: STRING, value: STRING }, ["flowId", "promptId", "value"]), queue: "immediate", handler: command("providers.respondAuth") }),
  registerPiCapability({ name: "providers.cancelAuth", scope: "global", description: "Cancel provider authentication", paramsSchema: objectSchema({ flowId: STRING }, ["flowId"]), queue: "immediate", handler: command("providers.cancelAuth") }),
  registerPiCapability({ name: "providers.logout", scope: "global", description: "Log out from a provider", paramsSchema: objectSchema({ providerId: STRING }, ["providerId"]), queue: "serialized", handler: command("providers.logout") }),
  registerPiCapability({ name: "modelRuntime.inspect", scope: "global", description: "Inspect the Pi model runtime", queue: "immediate", idempotent: true, handler: command("modelRuntime.inspect") }),
  registerPiCapability({ name: "modelRuntime.setApiKey", scope: "global", description: "Set a runtime provider API key", paramsSchema: objectSchema({ providerId: STRING, apiKey: STRING }, ["providerId", "apiKey"]), queue: "serialized", handler: command("modelRuntime.setApiKey") }),
  registerPiCapability({ name: "modelRuntime.removeApiKey", scope: "global", description: "Remove a runtime provider API key", paramsSchema: objectSchema({ providerId: STRING }, ["providerId"]), queue: "serialized", handler: command("modelRuntime.removeApiKey") }),
  registerPiCapability({ name: "modelRuntime.reload", scope: "global", description: "Reload model runtime config", queue: "serialized", handler: command("modelRuntime.reload") }),
  registerPiCapability({ name: "modelRuntime.refresh", scope: "global", description: "Refresh model runtime state", paramsSchema: objectSchema({ options: objectSchema({}, [], true) }), queue: "serialized", handler: command("modelRuntime.refresh") }),
  registerPiCapability({ name: "packages.list", scope: "global", description: "List configured Pi packages", paramsSchema: CWD_PARAMS, queue: "immediate", idempotent: true, handler: command("packages.list") }),
  registerPiCapability({ name: "packages.manage", scope: "global", description: "Install, remove, or update Pi packages", paramsSchema: objectSchema({ cwd: STRING, commandId: STRING, action: { enum: ["install", "remove", "update"] }, source: STRING, local: BOOLEAN, persist: BOOLEAN }, ["cwd", "commandId"]), queue: "serialized", handler: command("packages.manage") }),
  registerPiCapability({ name: "packages.resolve", scope: "global", description: "Resolve Pi packages for a workspace", paramsSchema: objectSchema({ cwd: STRING, missingAction: { enum: ["install", "skip", "error"] } }, ["cwd"]), queue: "serialized", handler: command("packages.resolve") }),
  registerPiCapability({ name: "packages.resolveSources", scope: "global", description: "Resolve explicit Pi package sources", paramsSchema: objectSchema({ cwd: STRING, sources: STRING_ARRAY, local: BOOLEAN, temporary: BOOLEAN }, ["cwd"]), queue: "serialized", handler: command("packages.resolveSources") }),
  registerPiCapability({ name: "packages.changeSource", scope: "global", description: "Add or remove a Pi package source", paramsSchema: objectSchema({ cwd: STRING, source: STRING, operation: { enum: ["add", "remove"] }, local: BOOLEAN }, ["cwd", "source"]), queue: "serialized", handler: command("packages.changeSource") }),
  registerPiCapability({ name: "packages.installedPath", scope: "global", description: "Read installed Pi package path", paramsSchema: objectSchema({ cwd: STRING, source: STRING, scope: { enum: ["user", "project"] } }, ["cwd", "source"]), queue: "immediate", idempotent: true, handler: command("packages.installedPath") }),
  registerPiCapability({ name: "packages.checkUpdates", scope: "global", description: "Check Pi package updates", paramsSchema: CWD_PARAMS, queue: "serialized", handler: command("packages.checkUpdates") }),
]

export const COMMAND_HANDLERS: Record<string, CommandHandler> = Object.fromEntries(
  COMMAND_REGISTRY.map(item => [item.capability.name, item.handler]),
)
