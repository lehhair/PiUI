import { randomUUID } from "node:crypto"
import type { JsonObject, JsonValue } from "@piui/protocol"
import { isJsonObject, problemFromError } from "@piui/protocol"
import { loadPiSdk } from "./sdk-host.js"
import { RealPiSession, type ExtensionHostActions } from "./real-session.js"
import { MockPiSession, MockCatalog } from "./mock-session.js"
import { PiCatalog } from "./catalog.js"
import { ProviderAuthHost } from "./provider-auth-host.js"
import { COMMAND_HANDLERS, type CommandContext } from "./command-table.js"
import { createWorkerCommandScheduler } from "./worker-command-scheduler.js"
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
const runtimeUnsubs: Array<() => void> = []

const driver = (process.env.PIUI_DRIVER ?? "mock").toLowerCase() === "pi" ? "pi" : "mock"

const catalog = driver === "pi" ? new PiCatalog() : new MockCatalog()
const providerAuth = new ProviderAuthHost(() => {
  const sessionRuntime = runtime as RealPiSession | undefined
  const fromSession = sessionRuntime instanceof RealPiSession ? sessionRuntime.getModelRuntime() : undefined
  if (fromSession) return Promise.resolve(fromSession)
  return import("./sdk-host.js").then(m => m.getLoadedSdk().sdk.ModelRuntime.create())
})

function send(message: WorkerMessage): void {
  process.send?.(message)
}

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
  }
}

async function openRuntime(params: JsonObject): Promise<JsonValue> {
  if (runtime) throw Object.assign(new Error("Pi runtime is already open"), { code: "SESSION_BUSY" })
  const cwd = P.reqString(params, "cwd")
  const sessionFile = P.optString(params, "sessionFile")
  const opened = driver === "pi"
    ? await RealPiSession.open(cwd, sessionFile, { hostActions })
    : await MockPiSession.open(cwd, sessionFile)
  runtime = opened
  subscribeRuntimeEvents(opened)
  if (opened instanceof RealPiSession) await opened.initializeExtensions()
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
  await current?.dispose()
}

const ctx: CommandContext = {
  get runtime() {
    return runtime
  },
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
  if (command.type === "session.open") return openRuntime(params)
  if (command.type === "session.close") {
    await closeRuntime()
    return undefined
  }
  const handler = COMMAND_HANDLERS[command.type]
  if (!handler) {
    throw Object.assign(new Error(`unknown command: ${command.type}`), { code: "UNKNOWN_COMMAND" })
  }
  return handler(ctx, params)
}

const schedule = createWorkerCommandScheduler(execute)

function toJsonObject(value: unknown): JsonObject {
  const json = JSON.parse(JSON.stringify(value)) as unknown
  if (!isJsonObject(json)) {
    throw Object.assign(new Error("value is not a JSON object"), { code: "NATIVE_DATA_NOT_JSON" })
  }
  return json
}

async function disposeAndExit(): Promise<void> {
  clearInterval(heartbeatTimer)
  unsubscribeProviderAuth()
  providerAuth.dispose()
  await closeRuntime()
  process.exit(0)
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
  if (request.command.type === "dispose") {
    send({ kind: "response", id: request.id, generation: workerGeneration, ok: true })
    setImmediate(() => void disposeAndExit())
    return
  }
  void schedule(request.command).then(
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
  void closeRuntime().finally(() => process.exit(0))
})

const loaded = await loadPiSdk({
  sdkPath: process.env.PIUI_SDK_PATH,
  strict: process.env.PIUI_SDK_STRICT === "1",
})

send({
  kind: "hello",
  workerProtocolVersion: PI_WORKER_PROTOCOL_VERSION,
  piSdkVersion: loaded.version,
  piSdkVerified: loaded.verified,
  generation: workerGeneration,
  processId: process.pid,
  heartbeatIntervalMs: PI_WORKER_HEARTBEAT_INTERVAL_MS,
})
