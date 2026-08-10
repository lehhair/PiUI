import { randomUUID } from "node:crypto"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { JsonObject, JsonValue, PiCapability, PiRegistrySnapshot } from "@piui/protocol"
import { isJsonObject, problemFromError, PROTOCOL_VERSION, validateParams } from "@piui/protocol"
import { loadPiSdk, shouldRequireVerifiedSdk, defaultSdkResolution, getLoadedSdk, type LoadedSdk } from "./sdk-host.js"
import { RealPiSession, type ExtensionHostActions } from "./runtime/real-session.js"
import { MockPiSession, MockCatalog } from "./runtime/mock-session.js"
import { PiCatalog } from "./runtime/catalog.js"
import { ProviderAuthHost } from "./runtime/provider-auth-host.js"
import { COMMAND_HANDLERS, listCommandCapabilities, resolveExtensionTarget, type CommandContext } from "./command-table.js"
import { assertRuntimeTargetBindings } from "./runtime-contract.js"
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
/**
 * 同一 worker 进程内的多会话 runtime：key = 当前 sessionId。
 * runtime 替换（newSession/switchSession/fork/import）后 key 迁移到新
 * sessionId。pi SDK 原生支持单进程多 runtime（共享 ModelRuntime）。
 */
const runtimes = new Map<string, SessionRuntime>()
/** 进程级共享 ModelRuntime（provider 认证/模型池本来就该全局共享一份） */
let sharedModelRuntime: ModelRuntime | undefined
let loadedSdkInfo: LoadedSdk | undefined
let registryRevision = 1
const registryDigests = new Map<string, string | undefined>()
let registryCheck: Promise<void> = Promise.resolve()

const driver = getDriverMode()

// 会话命令 → 驱动方法绑定门禁：缺实现或缺 target 直接启动失败（响亮，不回退）。
assertRuntimeTargetBindings()

function send(message: WorkerMessage): void {
  process.send?.(message)
}

const catalog = driver === "pi"
  ? new PiCatalog(undefined, event => send({ kind: "event", generation: workerGeneration, channel: "packages.progress", event }))
  : new MockCatalog()
const providerAuth = new ProviderAuthHost(async () => {
  // 共享 ModelRuntime：所有会话 runtime + provider 认证共用同一个实例
  // （SDK 的 createAgentSessionServices 接受注入的 modelRuntime）。
  sharedModelRuntime ??= await getLoadedSdk().sdk.ModelRuntime.create()
  return sharedModelRuntime
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

function subscribeRuntimeEvents(current: SessionRuntime): Array<() => void> {
  const unsubs: Array<() => void> = []
  unsubs.push(current.onPiEvent((event, meta) => send({
    kind: "event",
    generation: workerGeneration,
    sessionId: current.getSessionId(),
    channel: "pi.event",
    event,
    meta,
  })))
  unsubs.push(current.onHead(head => send({
    kind: "event",
    generation: workerGeneration,
    sessionId: current.getSessionId(),
    channel: "session.head",
    head: head as unknown as JsonObject,
  })))
  if (current.onActivity) {
    unsubs.push(current.onActivity(status => send({
      kind: "event",
      generation: workerGeneration,
      sessionId: current.getSessionId(),
      channel: "session.activity",
      event: { status: status as unknown as JsonValue },
    })))
  }
  if (current.onExtensionUi) {
    unsubs.push(current.onExtensionUi(event => send({
      kind: "event",
      generation: workerGeneration,
      sessionId: current.getSessionId(),
      channel: "extension.ui",
      event: toJsonObject(event),
    })))
  }
  if (current.onResourcesChanged) {
    unsubs.push(current.onResourcesChanged(() => send({
      kind: "event",
      generation: workerGeneration,
      channel: "resources.updated",
      workspacePath: current.getCwd(),
    })))
    unsubs.push(current.onResourcesChanged(() => {
      void queueRegistryChangeCheck(current, "resources.updated")
    }))
  }
  return unsubs
}

async function setRuntimeRegistryBaseline(sessionId: string, current: SessionRuntime): Promise<void> {
  registryDigests.set(sessionId, stableStringify(await current.getRegistry()))
}

function queueRegistryChangeCheck(current: SessionRuntime, reason: string): Promise<void> {
  registryCheck = registryCheck.then(() => detectRegistryChange(current, reason), () => detectRegistryChange(current, reason))
  return registryCheck
}

async function detectRegistryChange(current: SessionRuntime, reason: string): Promise<void> {
  const sessionId = current.getSessionId()
  if (runtimes.get(sessionId) !== current) return
  const next = stableStringify(await current.getRegistry())
  const digest = registryDigests.get(sessionId)
  if (digest === undefined) {
    registryDigests.set(sessionId, next)
    return
  }
  if (next === digest) return
  registryDigests.set(sessionId, next)
  registryRevision += 1
  send({
    kind: "event",
    generation: workerGeneration,
    sessionId,
    channel: "registry.updated",
    event: { revision: registryRevision, sessionId, reason },
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
  const cwd = P.reqString(params, "cwd")
  const sessionFile = P.optString(params, "sessionFile")
  const opened = driver === "pi"
    ? await RealPiSession.open(cwd, sessionFile, {
      hostActions,
      modelRuntime: sharedModelRuntime,
    })
    : await MockPiSession.open(cwd, sessionFile)
  const sessionId = opened.getSessionId()
  const unsubs = subscribeRuntimeEvents(opened)
  runtimes.set(sessionId, opened)
  try {
    if (opened instanceof RealPiSession) await opened.initializeExtensions()
    await setRuntimeRegistryBaseline(sessionId, opened)
  } catch (error) {
    runtimes.delete(sessionId)
    registryDigests.delete(sessionId)
    unsubs.forEach(unsub => unsub())
    await opened.dispose()
    throw error
  }
  return {
    sessionId,
    sessionFile: opened.getSessionFile() ?? null,
    cwd: opened.getCwd(),
    state: await opened.getState(),
  }
}

async function closeRuntime(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return
  const current = runtimes.get(sessionId)
  if (!current) return
  runtimes.delete(sessionId)
  registryDigests.delete(sessionId)
  await current.dispose()
}

const ctx: CommandContext = {
  get runtime() {
    return undefined
  },
  driver,
  catalog,
  auth: providerAuth,
  packages: catalog,
  requireRuntime(): SessionRuntime {
    throw Object.assign(new Error("Pi runtime is not open"), { code: "RUNTIME_NOT_OPEN" })
  },
}

async function execute(command: { type: string; params?: JsonObject; sessionId?: string }): Promise<JsonValue | undefined | void> {
  const params = command.params ?? {}
  if (command.type === "registry.describe") return describeRegistry()
  if (command.type === "session.open") return openRuntime(params)
  if (command.type === "session.close") {
    await closeRuntime(command.sessionId)
    return undefined
  }
  // 会话命令按 sessionId 路由到对应 runtime；找不到即 RUNTIME_REPLACED
  // （替换后 server 尚未同步新身份，或 runtime 已关闭）。
  const current = command.sessionId ? runtimes.get(command.sessionId) : undefined
  if (command.sessionId && !current) {
    throw Object.assign(new Error("Pi runtime no longer owns the requested session"), { code: "RUNTIME_REPLACED" })
  }
  const commandCtx: CommandContext = {
    get runtime() {
      return current
    },
    driver,
    catalog,
    auth: providerAuth,
    packages: catalog,
    requireRuntime(): SessionRuntime {
      if (!current) throw Object.assign(new Error("Pi runtime is not open"), { code: "RUNTIME_NOT_OPEN" })
      return current
    },
  }
  const handler = COMMAND_HANDLERS[command.type]
  if (!handler) {
    // 静态表未命中：对照 Pi 运行时自己的注册表原生分发扩展命令/工具。
    if (current) {
      const registry = await current.getRegistry()
      const target = resolveExtensionTarget(registry, command.type)
      if (target === "tool") {
        // 工具参数 schema 来自 Pi 自己的工具定义（typebox 序列化后的 JSON
        // Schema）——在分发边界校验，畸形入参响亮 INVALID_REQUEST。
        const tool = registry.tools.find(item => item.name === command.type)
        if (tool?.parameters) validateParams(tool.parameters, params ?? {})
        return current.invokeTool(command.type, params)
      }
      if (target === "command") {
        const args = typeof params?.args === "string" ? params.args : undefined
        return current.invokeCommand(command.type, args)
      }
    }
    throw Object.assign(new Error(`unknown command: ${command.type}`), { code: "UNKNOWN_COMMAND" })
  }
  const result = await handler(commandCtx, params)
  // Runtime replacement (newSession/switchSession/fork/import) changes the
  // session identity inside the SDK; migrate the map key so subsequent
  // requests with the new sessionId find the same runtime.
  if (current) {
    const currentId = current.getSessionId()
    if (command.sessionId !== currentId) {
      runtimes.delete(command.sessionId!)
      runtimes.set(currentId, current)
      const digest = registryDigests.get(command.sessionId!)
      registryDigests.delete(command.sessionId!)
      registryDigests.set(currentId, digest)
    }
  }
  if (current && shouldCheckRegistryAfter(command.type)) {
    await queueRegistryChangeCheck(current, `command:${command.type}`)
  }
  return result
}

const REGISTRY_READ_COMMANDS = new Set(["state.get", "entries.get", "branch.get", "tree.get", "registry.get", "attachment.get", "waitForIdle"])

function shouldCheckRegistryAfter(type: string): boolean {
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

const schedule = createWorkerCommandScheduler(async command => execute(command))

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
  for (const sessionId of [...runtimes.keys()]) {
    await closeRuntime(sessionId).catch(() => undefined)
  }
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

// 扩展的异步疏忽（如延迟回调持有 stale ctx）会产生未捕获异常/拒绝。
// 记录并继续运行：单个扩展的错误不应杀死 worker 进程（worker 崩溃会让
// 所有已 attach 的 session 一起丢失）。正常退出只走 IPC disconnect。
process.on("unhandledRejection", (reason) => {
  console.error(`[piui-worker] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
})
process.on("uncaughtException", (error) => {
  console.error(`[piui-worker] uncaught exception: ${error?.stack ?? error}`)
})

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
    // 多 runtime 共享调度器：session.close 只是普通命令（关一个 runtime），
    // 不能 closing 整个调度器；只有 dispose（进程退出）才排空调度器。
    void schedule({ ...request.command, sessionId: request.sessionId }).then(
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
// 严格模式（PIUI_SDK_STRICT=1）要求外部 SDK 与验证版本一致；缺省为 advisory，
// 外部 SDK 加载失败时回退到内置 SDK 并上报详情。
const strict = resolution.source !== "bundled" && shouldRequireVerifiedSdk()
let loaded: LoadedSdk
if (resolution.source === "bundled") {
  loaded = await loadPiSdk()
} else {
  try {
    loaded = await loadPiSdk({ sdkPath: resolution.sdkPath, strict })
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "PI_SDK_INCOMPATIBLE"
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[piui-worker] external Pi SDK failed to load (${code}): ${message}; falling back to the bundled SDK`)
    loaded = await loadPiSdk()
    loaded.fallbackFrom = { source: resolution.source, message, code }
  }
}
loadedSdkInfo = loaded

send({
  kind: "hello",
  workerProtocolVersion: PI_WORKER_PROTOCOL_VERSION,
  piSdkVersion: loaded.version,
  piSdkVerified: loaded.verified,
  piSdkFallback: loaded.fallbackFrom,
  generation: workerGeneration,
  processId: process.pid,
  heartbeatIntervalMs: PI_WORKER_HEARTBEAT_INTERVAL_MS,
})
