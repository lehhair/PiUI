import { randomUUID } from "node:crypto"
import type { JsonObject, JsonValue, PiCapability, PiRegistrySnapshot } from "@piui/protocol"
import { isJsonObject, problemFromError, PROTOCOL_VERSION } from "@piui/protocol"
import { loadPiSdk, shouldRequireVerifiedSdk, defaultSdkResolution } from "./sdk-host.js"
import { RealPiSession, type ExtensionHostActions } from "./runtime/real-session.js"
import { MockPiSession, MockCatalog } from "./runtime/mock-session.js"
import { PiCatalog } from "./runtime/catalog.js"
import { ProviderAuthHost } from "./runtime/provider-auth-host.js"
import { COMMAND_HANDLERS, listCommandCapabilities, type CommandContext } from "./command-table.js"
import { createWorkerCommandScheduler } from "./worker-command-scheduler.js"
import { getDriverMode } from "./driver.js"
import {
  PI_WORKER_HEARTBEAT_INTERVAL_MS,
  PI_WORKER_PROTOCOL_VERSION,
  type WorkerHostCall,
  type WorkerHostReply,
  type WorkerMessage,
  type WorkerParentMessage,
  type WorkerRequest,
} from "./ipc.js"
import type { SessionRuntime } from "./runtime.js"
import * as P from "./params.js"

const workerGeneration = randomUUID()
let runtime: SessionRuntime | undefined
let loadedSdkInfo: { version: string; verified: boolean } | undefined
let registryRevision = 1
let runtimeRegistryDigest: string | undefined
let registryCheck: Promise<void> = Promise.resolve()
const runtimeUnsubs: Array<() => void> = []

const driver = getDriverMode()

function send(message: WorkerMessage): void {
  process.send?.(message)
}

const catalog = driver === "pi"
  ? new PiCatalog(undefined, event => send({ kind: "event", generation: workerGeneration, channel: "packages.progress", event }))
  : new MockCatalog()
const providerAuth = new ProviderAuthHost(() => {
  const sessionRuntime = runtime as RealPiSession | undefined
  const fromSession = sessionRuntime instanceof RealPiSession ? sessionRuntime.getModelRuntime() : undefined
  if (fromSession) return Promise.resolve(fromSession)
  return import("./sdk-host.js").then(m => m.getLoadedSdk().sdk.ModelRuntime.create())
})

const pendingHostCalls = new Map<string, {
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}>()

function callHost(call: WorkerHostCall): Promise<void> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHostCalls.delete(id)
      reject(Object.assign(new Error("PiUI host call timed out"), { code: "HOST_CALL_TIMEOUT" }))
    }, 15_000)
    timer.unref()
    pendingHostCalls.set(id, { resolve, reject, timer })
    process.send?.({ kind: "hostCall", id, generation: workerGeneration, call }, error => {
      if (!error) return
      const pending = pendingHostCalls.get(id)
      if (pending) clearTimeout(pending.timer)
      pendingHostCalls.delete(id)
      reject(error)
    })
  })
}

const hostActions: ExtensionHostActions = {
  reserveReplacement: request => callHost({ type: "extensionReplacement.reserve", ...request }),
  commitReplacement: (reservationId, replacement) => {
    providerAuth.resetRuntime()
    return callHost({ type: "extensionReplacement.commit", reservationId, replacement })
  },
  abortReplacement: reservationId => callHost({ type: "extensionReplacement.abort", reservationId }),
  requestShutdown: sessionId => {
    void callHost({ type: "extensionShutdown", sessionId }).catch(error => {
      console.error(`[piui-worker] extension shutdown request failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  },
}

function subscribeRuntimeEvents(current: SessionRuntime): void {
  runtimeUnsubs.push(current.onPiEvent((event, meta) => send({
    kind: "event",
    generation: workerGeneration,
    sessionId: current.getSessionId(),
    channel: "pi.event",
    event,
    meta,
  })))
  runtimeUnsubs.push(current.onHead(head => send({
    kind: "event",
    generation: workerGeneration,
    sessionId: current.getSessionId(),
    channel: "session.head",
    head: head as unknown as JsonObject,
  })))
  if (current.onActivity) {
    runtimeUnsubs.push(current.onActivity(status => send({
      kind: "event",
      generation: workerGeneration,
      sessionId: current.getSessionId(),
      channel: "session.activity",
      event: { status: status as unknown as JsonValue },
    })))
  }
  if (current.onExtensionUi) {
    runtimeUnsubs.push(current.onExtensionUi(event => send({
      kind: "event",
      generation: workerGeneration,
      sessionId: current.getSessionId(),
      channel: "extension.ui",
      event: toJsonObject(event),
    })))
  }
  if (current.onResourcesChanged) {
    runtimeUnsubs.push(current.onResourcesChanged(() => send({
      kind: "event",
      generation: workerGeneration,
      channel: "resources.updated",
      workspacePath: current.getCwd(),
    })))
    runtimeUnsubs.push(current.onResourcesChanged(() => {
      void queueRegistryChangeCheck(current, "resources.updated")
    }))
  }
}

async function setRuntimeRegistryBaseline(current: SessionRuntime): Promise<void> {
  runtimeRegistryDigest = stableStringify(await current.getRegistry())
}

function queueRegistryChangeCheck(current: SessionRuntime, reason: string): Promise<void> {
  registryCheck = registryCheck.then(() => detectRegistryChange(current, reason), () => detectRegistryChange(current, reason))
  return registryCheck
}

async function detectRegistryChange(current: SessionRuntime, reason: string): Promise<void> {
  if (runtime !== current) return
  const next = stableStringify(await current.getRegistry())
  if (runtimeRegistryDigest === undefined) {
    runtimeRegistryDigest = next
    return
  }
  if (next === runtimeRegistryDigest) return
  runtimeRegistryDigest = next
  registryRevision += 1
  send({
    kind: "event",
    generation: workerGeneration,
    sessionId: current.getSessionId(),
    channel: "registry.updated",
    event: { revision: registryRevision, sessionId: current.getSessionId(), reason },
  })
}

function stableStringify(value: JsonValue): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, sortJson(value[key] ?? null)]),
  )
}

async function openRuntime(params: JsonObject): Promise<JsonValue> {
  if (runtime) throw Object.assign(new Error("Pi runtime is already open"), { code: "SESSION_BUSY" })
  const cwd = P.reqString(params, "cwd")
  const sessionFile = P.optString(params, "sessionFile")
  const opened = driver === "pi"
    ? await RealPiSession.open(cwd, sessionFile, { hostActions })
    : await MockPiSession.open(cwd, sessionFile)
  runtime = opened
  // Provider auth may have initialized a standalone runtime before the
  // session opened. Rebind it to the session runtime; temporary API keys are
  // retained by ProviderAuthHost and reapplied there.
  providerAuth.resetRuntime()
  subscribeRuntimeEvents(opened)
  try {
    if (opened instanceof RealPiSession) await opened.initializeExtensions()
    await setRuntimeRegistryBaseline(opened)
  } catch (error) {
    runtimeUnsubs.splice(0).forEach(unsub => unsub())
    runtime = undefined
    runtimeRegistryDigest = undefined
    await opened.dispose()
    throw error
  }
  return {
    sessionId: opened.getSessionId(),
    sessionFile: opened.getSessionFile() ?? null,
    cwd: opened.getCwd(),
    state: await opened.getState(),
  }
}

async function closeRuntime(): Promise<void> {
  runtimeUnsubs.splice(0).forEach(unsub => unsub())
  const current = runtime
  runtime = undefined
  runtimeRegistryDigest = undefined
  await current?.dispose()
}

const ctx: CommandContext = {
  get runtime() {
    return runtime
  },
  driver,
  catalog,
  auth: providerAuth,
  packages: catalog,
  requireRuntime(): SessionRuntime {
    if (!runtime) throw Object.assign(new Error("Pi runtime is not open"), { code: "RUNTIME_NOT_OPEN" })
    return runtime
  },
}

async function execute(command: { type: string; params?: JsonObject }): Promise<JsonValue | undefined | void> {
  const params = command.params ?? {}
  if (command.type === "registry.describe") return describeRegistry()
  if (command.type === "session.open") return openRuntime(params)
  if (command.type === "session.close") {
    await closeRuntime()
    return undefined
  }
  const handler = COMMAND_HANDLERS[command.type]
  if (!handler) {
    throw Object.assign(new Error(`unknown command: ${command.type}`), { code: "UNKNOWN_COMMAND" })
  }
  const result = await handler(ctx, params)
  if (runtime && shouldCheckRegistryAfter(command.type)) {
    await queueRegistryChangeCheck(runtime, `command:${command.type}`)
  }
  return result
}

const REGISTRY_READ_COMMANDS = new Set(["state.get", "entries.get", "branch.get", "tree.get", "registry.get", "attachment.get", "waitForIdle"])

function shouldCheckRegistryAfter(type: string): boolean {
  if (!runtime) return false
  if (type.startsWith("session.") || type.startsWith("models.") || type.startsWith("settings.") ||
    type.startsWith("trust.") || type.startsWith("providers.") || type.startsWith("modelRuntime.") ||
    type.startsWith("packages.")) return false
  return !REGISTRY_READ_COMMANDS.has(type)
}

function describeRegistry(): PiRegistrySnapshot {
  const registryDescribe: PiCapability = {
    name: "registry.describe",
    scope: "global",
    source: "piui-adapter",
    description: "Describe registered Pi capabilities exposed by this worker",
    paramsSchema: { type: "object", additionalProperties: false, properties: {} },
    queue: "immediate",
    idempotent: true,
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision: registryRevision,
    sdkVersion: loadedSdkInfo?.version ?? "unknown",
    driver,
    globalCommands: [registryDescribe, ...listCommandCapabilities("global")],
    sessionCommands: listCommandCapabilities("session"),
  }
}

const schedule = createWorkerCommandScheduler(async command => {
  if (command.sessionId && runtime && runtime.getSessionId() !== command.sessionId) {
    throw Object.assign(new Error("Pi runtime no longer owns the requested session"), { code: "RUNTIME_REPLACED" })
  }
  return execute(command)
})

function toJsonObject(value: unknown): JsonObject {
  const json = JSON.parse(JSON.stringify(value)) as unknown
  if (!isJsonObject(json)) {
    throw Object.assign(new Error("value is not a JSON object"), { code: "NATIVE_DATA_NOT_JSON" })
  }
  return json
}

async function cleanupWorker(): Promise<void> {
  clearInterval(heartbeatTimer)
  unsubscribeProviderAuth()
  providerAuth.dispose()
  await closeRuntime()
}

const unsubscribeProviderAuth = providerAuth.onEvent(event => send({
  kind: "event",
  generation: workerGeneration,
  channel: "provider.auth",
  event: toJsonObject(event),
}))

const heartbeatTimer = setInterval(() => {
  send({ kind: "heartbeat", generation: workerGeneration, timestamp: Date.now() })
}, PI_WORKER_HEARTBEAT_INTERVAL_MS)
heartbeatTimer.unref()

function toResponseData(data: JsonValue | undefined | void): JsonValue | undefined {
  return data === undefined ? undefined : data as JsonValue
}

process.on("message", (value: unknown) => {
  const message = value as WorkerParentMessage
  if (message?.kind === "hostReply") {
    const reply = message as WorkerHostReply
    const pending = pendingHostCalls.get(reply.id)
    if (!pending || reply.generation !== workerGeneration) return
    pendingHostCalls.delete(reply.id)
    clearTimeout(pending.timer)
    if (reply.ok) pending.resolve()
    else pending.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }))
    return
  }
  const request = message as WorkerRequest
  if (!request || request.kind !== "request" || typeof request.id !== "string") return
  if (request.generation !== workerGeneration) {
    send({
      kind: "response",
      id: request.id,
      generation: workerGeneration,
      ok: false,
      error: { code: "WORKER_PROTOCOL_MISMATCH", message: "Pi worker generation mismatch" },
    })
    return
  }
  if (request.sessionId && runtime && runtime.getSessionId() !== request.sessionId) {
    send({
      kind: "response",
      id: request.id,
      generation: workerGeneration,
      ok: false,
      error: { code: "RUNTIME_REPLACED", message: "Pi runtime no longer owns the requested session" },
    })
    return
  }
  if (!request.command || typeof request.command.type !== "string") {
    send({
      kind: "response",
      id: request.id,
      generation: workerGeneration,
      ok: false,
      error: { code: "INVALID_REQUEST", message: "malformed worker request" },
    })
    return
  }
  if (request.command.type === "dispose") {
    void schedule.close(cleanupWorker).then(
      () => {
        send({ kind: "response", id: request.id, generation: workerGeneration, ok: true })
        setImmediate(() => process.exit(0))
      },
      error => {
        send({
          kind: "response",
          id: request.id,
          generation: workerGeneration,
          ok: false,
          error: problemFromError(error),
        })
        setImmediate(() => process.exit(1))
      },
    )
    return
  }
  if (request.command.type === "session.close") {
    void schedule.close(closeRuntime).then(
      () => {
        send({ kind: "response", id: request.id, generation: workerGeneration, ok: true })
      },
      error => {
        send({
          kind: "response",
          id: request.id,
          generation: workerGeneration,
          ok: false,
          error: problemFromError(error),
        })
      },
    )
    return
  }
  void schedule({ ...request.command, sessionId: request.sessionId }).then(
    data => {
      send({ kind: "response", id: request.id, generation: workerGeneration, ok: true, data: toResponseData(data) })
    },
    error => {
      send({
        kind: "response",
        id: request.id,
        generation: workerGeneration,
        ok: false,
        error: problemFromError(error),
      })
    },
  )
})

process.on("disconnect", () => {
  clearInterval(heartbeatTimer)
  for (const pending of pendingHostCalls.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error("PiUI host disconnected"))
  }
  pendingHostCalls.clear()
  void (async () => {
    let exitCode = 0
    try {
      await schedule.close(cleanupWorker)
    } catch (error) {
      console.error(`[piui-worker] disconnect cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      exitCode = 1
    }
    process.exit(exitCode)
  })()
})

const resolution = defaultSdkResolution()
if (resolution.source !== "bundled") {
  console.info(`[piui-worker] pi sdk source=${resolution.source} path=${resolution.sdkPath}`)
}
const loaded = await loadPiSdk({
  sdkPath: resolution.sdkPath,
  // 系统 SDK 是显式 opt-in；路径 SDK 默认要求与验证版本一致
  strict: resolution.source === "env" && shouldRequireVerifiedSdk(),
})
loadedSdkInfo = loaded

send({
  kind: "hello",
  workerProtocolVersion: PI_WORKER_PROTOCOL_VERSION,
  piSdkVersion: loaded.version,
  piSdkVerified: loaded.verified,
  generation: workerGeneration,
  processId: process.pid,
  heartbeatIntervalMs: PI_WORKER_HEARTBEAT_INTERVAL_MS,
})
