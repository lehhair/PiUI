import { randomUUID } from "node:crypto"
import { PI_PARITY_SDK_VERSION } from "@piui/protocol"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { RealPiSession } from "./real-session.js"
import { ProviderAuthHost } from "./provider-auth-host.js"
import type { PiSessionRuntime } from "./runtime-contract.js"
import { createWorkerCommandScheduler } from "./worker-command-scheduler.js"
import {
  PI_WORKER_PROTOCOL_VERSION,
  PI_WORKER_HEARTBEAT_INTERVAL_MS,
  type PiWorkerCapability,
  type ProjectionWire,
  type WorkerCommand,
  type WorkerMessage,
  type WorkerRequest,
  type WorkerResult,
  type WorkerSessionWire,
} from "./worker-protocol.js"

let runtime: PiSessionRuntime | undefined
let unsubscribeState: (() => void) | undefined
let unsubscribeProjectionDelta: (() => void) | undefined
let unsubscribeNativeEvent: (() => void) | undefined
let unsubscribeResourcesChanged: (() => void) | undefined
let unsubscribeExtensionUi: (() => void) | undefined
const workerGeneration = randomUUID()
const providerAuth = new ProviderAuthHost(() => {
  const sessionRuntime = runtime as (PiSessionRuntime & { getModelRuntime?: () => ModelRuntime }) | undefined
  return sessionRuntime?.getModelRuntime ? Promise.resolve(sessionRuntime.getModelRuntime()) : ModelRuntime.create()
})
const unsubscribeProviderAuth = providerAuth.onEvent(event => send({
  kind: "event",
  generation: workerGeneration,
  type: "providerAuth",
  event,
}))
const heartbeatTimer = setInterval(() => {
  send({ kind: "heartbeat", generation: workerGeneration, timestamp: Date.now() })
}, PI_WORKER_HEARTBEAT_INTERVAL_MS)
heartbeatTimer.unref()
const workerCapabilities: PiWorkerCapability[] = [
  "catalog.sessions",
  "catalog.models",
  "runtime.open",
  "runtime.prompt",
  "runtime.control",
  "runtime.abort",
  "runtime.model",
  "runtime.thinking",
  "runtime.compact",
  "runtime.retry",
  "runtime.tools",
  "runtime.tree",
  "runtime.fork",
  "runtime.import",
  "runtime.skills",
  "runtime.commands",
  "runtime.bash",
  "runtime.export",
  "runtime.reload",
  "runtime.extensionUi",
  "management.settings",
  "management.trust",
  "management.auth",
  "management.packages",
]

function send(message: WorkerMessage): void {
  process.send?.(message)
}

function projectionWire(value: ProjectionWire = requireRuntime().getProjection()): ProjectionWire {
  return {
    timeline: value.timeline,
    isStreaming: value.isStreaming,
    removedItemIds: value.removedItemIds,
  }
}

function sessionWire(): WorkerSessionWire {
  const current = requireRuntime()
  return {
    sessionId: current.getSessionId(),
    sessionFile: current.getSessionFile(),
    sessionName: current.getSessionName(),
    projection: projectionWire(current.getProjection()),
    state: current.getRuntimeUiState(),
    entries: current.getEntries(),
    tree: current.getTree(),
    leafId: current.getLeafId(),
  }
}

function requireRuntime(): PiSessionRuntime {
  if (!runtime) throw Object.assign(new Error("Pi runtime is not open"), { code: "RUNTIME_NOT_OPEN" })
  return runtime
}

async function execute(command: WorkerCommand): Promise<WorkerResult> {
  switch (command.type) {
    case "list":
      return { type: "sessions", sessions: await RealPiSession.list(command.cwd) }
    case "listAll":
      return { type: "sessions", sessions: await RealPiSession.listAll() }
    case "listModels":
      return { type: "models", models: await RealPiSession.listModels() }
    case "getSettings":
      return { type: "settings", settings: RealPiSession.getSettings(command.cwd) }
    case "patchSettings":
      return { type: "settings", settings: await RealPiSession.patchSettings(command.cwd, command.patch) }
    case "getProjectTrust":
      return { type: "trust", trust: RealPiSession.getProjectTrust(command.cwd) }
    case "setProjectTrust":
      return { type: "trust", trust: RealPiSession.setProjectTrust(command.cwd, command.decision) }
    case "listProviders":
      return { type: "providers", providers: await providerAuth.listProviders() }
    case "startProviderAuth":
      return { type: "authFlow", flowId: await providerAuth.start(command.providerId, command.authType) }
    case "respondProviderAuth":
      providerAuth.respond(command.flowId, command.promptId, command.value)
      return { type: "ok" }
    case "cancelProviderAuth":
      providerAuth.cancel(command.flowId)
      return { type: "ok" }
    case "logoutProvider":
      await providerAuth.logout(command.providerId)
      return { type: "ok" }
    case "inspectModelRuntime":
      return { type: "modelRuntime", runtime: await providerAuth.inspect() }
    case "setRuntimeApiKey":
      await providerAuth.setRuntimeApiKey(command.providerId, command.apiKey)
      return { type: "ok" }
    case "removeRuntimeApiKey":
      await providerAuth.removeRuntimeApiKey(command.providerId)
      return { type: "ok" }
    case "reloadModelRuntime":
      await providerAuth.reloadConfig()
      return { type: "ok" }
    case "refreshModelRuntime":
      return { type: "modelRefresh", result: await providerAuth.refresh(command.options) }
    case "listPackages":
      return { type: "packages", packages: RealPiSession.listPackages(command.cwd) }
    case "managePackage":
      return {
        type: "packages",
        packages: await RealPiSession.managePackage(
          command.cwd,
          command.commandId,
          command.action,
          command.source,
          command.local === true,
          command.persist !== false,
          event => send({ kind: "event", generation: workerGeneration, type: "packageProgress", event }),
        ),
      }
    case "resolvePackages":
      return { type: "packageResources", resources: await RealPiSession.resolvePackages(command.cwd, command.missingAction) }
    case "resolveExtensionSources":
      return {
        type: "packageResources",
        resources: await RealPiSession.resolveExtensionSources(command.cwd, command.sources, command),
      }
    case "changePackageSource": {
      const changed = await RealPiSession.changePackageSource(
        command.cwd, command.source, command.operation, command.local,
      )
      return { type: "packageSource", ...changed }
    }
    case "getInstalledPackagePath":
      return {
        type: "packagePath",
        path: RealPiSession.getInstalledPackagePath(command.cwd, command.source, command.scope),
      }
    case "checkPackageUpdates":
      return { type: "packageUpdates", updates: await RealPiSession.checkPackageUpdates(command.cwd) }
    case "open": {
      if (runtime) throw Object.assign(new Error("Pi runtime is already open"), { code: "RUNTIME_ALREADY_OPEN" })
      runtime = await RealPiSession.open(command.cwd, command.sessionFile)
      unsubscribeState = runtime.onState(state => send({
        kind: "event",
        generation: workerGeneration,
        type: "state",
        state,
      }))
      unsubscribeProjectionDelta = runtime.onProjectionDelta(projection => send({
        kind: "event",
        generation: workerGeneration,
        type: "projectionDelta",
        projection: projectionWire(projection),
      }))
      unsubscribeNativeEvent = runtime.onNativeEvent?.(event => send({
        kind: "event",
        generation: workerGeneration,
        type: "nativeEvent",
        event,
      }))
      unsubscribeResourcesChanged = runtime.onResourcesChanged?.(() => send({
        kind: "event",
        generation: workerGeneration,
        type: "resourcesChanged",
      }))
      unsubscribeExtensionUi = runtime.onExtensionUi?.(event => send({
        kind: "event",
        generation: workerGeneration,
        type: "extensionUi",
        event,
      }))
      return { type: "session", session: sessionWire() }
    }
    case "prompt": {
      await requireRuntime().prompt(command.text, command.images)
      return { type: "session", session: sessionWire() }
    }
    case "steer":
      await requireRuntime().steer(command.text, command.images)
      return { type: "session", session: sessionWire() }
    case "followUp":
      await requireRuntime().followUp(command.text, command.images)
      return { type: "session", session: sessionWire() }
    case "abort":
      return { type: "queue", ...await requireRuntime().abort(), session: sessionWire() }
    case "setModel":
      await requireRuntime().setModel(command.provider, command.modelId)
      return { type: "session", session: sessionWire() }
    case "setThinkingLevel":
      await requireRuntime().setThinkingLevel(command.level)
      return { type: "session", session: sessionWire() }
    case "cycleThinkingLevel": {
      const level = await requireRuntime().cycleThinkingLevel()
      return { type: "thinkingLevel", level, session: sessionWire() }
    }
    case "sendUserMessage":
      await requireRuntime().sendUserMessage(command.text, command.images, command.deliverAs)
      return { type: "session", session: sessionWire() }
    case "compact": {
      const compaction = await requireRuntime().compact(command.instructions)
      return { type: "compaction", compaction, session: sessionWire() }
    }
    case "abortCompaction":
      await requireRuntime().abortCompaction()
      return { type: "session", session: sessionWire() }
    case "abortBranchSummary":
      await requireRuntime().abortBranchSummary()
      return { type: "session", session: sessionWire() }
    case "abortRetry":
      await requireRuntime().abortRetry()
      return { type: "session", session: sessionWire() }
    case "setAutoCompaction":
      await requireRuntime().setAutoCompaction(command.enabled)
      return { type: "session", session: sessionWire() }
    case "setAutoRetry":
      await requireRuntime().setAutoRetry(command.enabled)
      return { type: "session", session: sessionWire() }
    case "setQueueModes":
      await requireRuntime().setQueueModes(command)
      return { type: "session", session: sessionWire() }
    case "clearQueue": {
      const queue = await requireRuntime().clearQueue()
      return { type: "queue", ...queue, session: sessionWire() }
    }
    case "setActiveTools":
      await requireRuntime().setActiveTools(command.toolNames)
      return { type: "session", session: sessionWire() }
    case "cycleModel":
      await requireRuntime().cycleModel(command.direction)
      return { type: "session", session: sessionWire() }
    case "setScopedModels": {
      const diagnostics = await requireRuntime().setScopedModels(command.patterns)
      return { type: "scopedModels", diagnostics, session: sessionWire() }
    }
    case "listRuntimeModels":
      return { type: "models", models: await requireRuntime().listAvailableModels() }
    case "sendCustomMessage":
      await requireRuntime().sendCustomMessage(command.customType, command.content, command)
      return { type: "session", session: sessionWire() }
    case "appendCustomEntry":
      await requireRuntime().appendCustomEntry(command.customType, command.data)
      return { type: "session", session: sessionWire() }
    case "waitForIdle":
      await requireRuntime().waitForIdle()
      return { type: "session", session: sessionWire() }
    case "inspectToolDefinition":
      return { type: "data", data: await requireRuntime().getToolDefinition(command.toolName) }
    case "hasExtensionHandlers":
      return { type: "boolean", value: await requireRuntime().hasExtensionHandlers(command.eventType) }
    case "inspectSystemPrompt":
      return { type: "text", text: await requireRuntime().getSystemPrompt() }
    case "inspectRuntime":
      return { type: "runtimeInspection", inspection: await requireRuntime().inspectRuntime() }
    case "inspectResources":
      return { type: "resources", resources: await requireRuntime().inspectResources() }
    case "extendResources":
      await requireRuntime().extendResources(command.paths)
      return { type: "resources", resources: await requireRuntime().inspectResources() }
    case "executeBash": {
      const result = await requireRuntime().executeBash(command.command, command.excludeFromContext)
      return { type: "bash", result, session: sessionWire() }
    }
    case "abortBash":
      await requireRuntime().abortBash()
      return { type: "session", session: sessionWire() }
    case "exportHtml":
      return { type: "export", format: "html", path: await requireRuntime().exportHtml(command.outputPath) }
    case "exportJsonl":
      return { type: "export", format: "jsonl", path: await requireRuntime().exportJsonl(command.outputPath) }
    case "reload":
      await requireRuntime().reload()
      return { type: "session", session: sessionWire() }
    case "initializeExtensions":
      await requireRuntime().initializeExtensions?.()
      return { type: "session", session: sessionWire() }
    case "respondExtensionUi": {
      const accepted = await requireRuntime().respondExtensionUi?.(command.requestId, command.response)
      if (!accepted) {
        throw Object.assign(new Error("extension UI request is no longer pending"), { code: "EXTENSION_UI_CANCELLED" })
      }
      return { type: "ok" }
    }
    case "setExtensionEditorState":
      await requireRuntime().setExtensionEditorState?.(command.text)
      return { type: "ok" }
    case "navigateTree": {
      const result = await requireRuntime().navigateTree(command.entryId, {
        summarize: command.summarize,
        customInstructions: command.customInstructions,
        replaceInstructions: command.replaceInstructions,
        label: command.label,
      })
      return { type: "navigation", ...result, session: sessionWire() }
    }
    case "setLabel":
      await requireRuntime().setLabel(command.entryId, command.label)
      return { type: "session", session: sessionWire() }
    case "setSessionName":
      await requireRuntime().setSessionName(command.name)
      return { type: "session", session: sessionWire() }
    case "fork": {
      const replacement = await requireRuntime().fork(command.entryId, command.position)
      if (!replacement.cancelled) providerAuth.resetRuntime()
      return { type: "replacement", replacement, session: sessionWire() }
    }
    case "clone": {
      const replacement = await requireRuntime().clone(command.entryId)
      if (!replacement.cancelled) providerAuth.resetRuntime()
      return { type: "replacement", replacement, session: sessionWire() }
    }
    case "newSession": {
      const replacement = await requireRuntime().newSession(command.parentSession)
      if (!replacement.cancelled) providerAuth.resetRuntime()
      return { type: "replacement", replacement, session: sessionWire() }
    }
    case "switchSession": {
      const replacement = await requireRuntime().switchSession(command.sessionPath, command.cwdOverride)
      if (!replacement.cancelled) providerAuth.resetRuntime()
      return { type: "replacement", replacement, session: sessionWire() }
    }
    case "importSession": {
      const replacement = await requireRuntime().importSession(command.inputPath, command.cwdOverride)
      if (!replacement.cancelled) providerAuth.resetRuntime()
      return { type: "replacement", replacement, session: sessionWire() }
    }
    case "listSkills":
      return { type: "skills", skills: await requireRuntime().listSkills() }
    case "listCommands":
      return { type: "commands", commands: await requireRuntime().listCommands() }
    case "dispose":
      clearInterval(heartbeatTimer)
      unsubscribeState?.()
      unsubscribeState = undefined
      unsubscribeProjectionDelta?.()
      unsubscribeProjectionDelta = undefined
      unsubscribeNativeEvent?.()
      unsubscribeNativeEvent = undefined
      unsubscribeResourcesChanged?.()
      unsubscribeResourcesChanged = undefined
      unsubscribeExtensionUi?.()
      unsubscribeExtensionUi = undefined
      unsubscribeProviderAuth()
      providerAuth.dispose()
      await runtime?.dispose()
      runtime = undefined
      return { type: "ok" }
  }
}

const schedule = createWorkerCommandScheduler(request => {
  if (request.sessionId && requireRuntime().getSessionId() !== request.sessionId) {
    throw Object.assign(new Error("Pi runtime no longer owns the requested session"), { code: "RUNTIME_REPLACED" })
  }
  return execute(request.command)
})

process.on("message", (value: unknown) => {
  const request = value as WorkerRequest
  if (!request || request.kind !== "request" || typeof request.id !== "string") return
  if (request.generation !== workerGeneration) {
    send({
      kind: "response",
      id: request.id,
      generation: workerGeneration,
      ok: false,
      error: { code: "WORKER_GENERATION_MISMATCH", message: "Pi worker generation mismatch" },
    })
    return
  }
  void schedule(request).then(
    result => {
      send({ kind: "response", id: request.id, generation: workerGeneration, ok: true, result })
      if (request.command.type === "dispose") setImmediate(() => process.exit(0))
    },
    error => {
      send({
        kind: "response",
        id: request.id,
        generation: workerGeneration,
        ok: false,
        error: {
          code: error && typeof error === "object" && "code" in error ? String(error.code) : "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    },
  )
})

send({
  kind: "hello",
  workerProtocolVersion: PI_WORKER_PROTOCOL_VERSION,
  piSdkVersion: PI_PARITY_SDK_VERSION,
  generation: workerGeneration,
  processId: process.pid,
  heartbeatIntervalMs: PI_WORKER_HEARTBEAT_INTERVAL_MS,
  capabilities: workerCapabilities,
})

process.on("disconnect", () => {
  clearInterval(heartbeatTimer)
  void (runtime?.dispose() ?? Promise.resolve()).finally(() => process.exit(0))
})
