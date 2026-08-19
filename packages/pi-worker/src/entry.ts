import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

// worker 的 stderr 是 inherit 到 server 的：桌面壳（Tauri）只保留最近 24
// 行内存缓冲，进程退出后全丢。这里把 worker 自己的 stderr 也追加写到
// 和 server 相同的日志目录，崩溃后可回溯（server 侧的 handleExit 日志在
// server 进程里写，worker 进程内的 uncaughtException 等在这里写）。
function wireWorkerStderrFileLog(): void {
  if (process.env.PIUI_FILE_LOG === "0") return
  let logDir: string | undefined
  const day = () => new Date().toISOString().slice(0, 10)
  let file: string | undefined
  let currentDay = ""
  const write = (chunk: string) => {
    try {
      if (!file || currentDay !== day()) {
        currentDay = day()
        if (!logDir) {
          const env = process.env.PIUI_DATA_DIR?.trim()
          logDir = env
            ? resolve(env)
            : process.platform === "win32" && process.env.APPDATA
              ? join(process.env.APPDATA, "com.piui.desktop")
              : join(homedir(), ".piui")
          logDir = join(logDir, "logs")
          mkdirSync(logDir, { recursive: true })
        }
        file = join(logDir!, `piui-server-${currentDay}.log`)
      }
      appendFileSync(file, `[${new Date().toISOString()}] ${chunk}`)
    } catch {
      /* 磁盘/权限问题不阻塞 */
    }
  }
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") write(chunk)
    return orig(chunk as never, ...(rest as never[]))
  }) as typeof process.stderr.write
}
wireWorkerStderrFileLog()

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
  try {
    process.send?.(message)
  } catch {
    // 通道已断（parent 消失）：disconnect 处理器会接手做有界清理退出，
    // 这里不能让 ERR_IPC_CHANNEL_CLOSED 炸进 uncaughtException
  }
}

/** 等 IPC flush 完再回调（用于退出前的最后一条消息）；通道不可用时立即回调 */
function sendWithCallback(message: WorkerMessage, callback: () => void): void {
  try {
    if (process.send) {
      process.send(message, () => callback())
      return
    }
  } catch {
    /* channel already gone */
  }
  callback()
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
  // 并发清理所有 runtime，且每个 dispose 有界（SDK 清理可能卡在 provider
  // 连接/流式响应上，串行会让关闭随会话数线性变慢）。超时的会话直接放弃
  // 等它——进程马上退出，锁由 server 侧兜底释放。
  await Promise.allSettled([...runtimes.keys()].map(async sessionId => {
    const current = runtimes.get(sessionId)
    if (!current) return
    runtimes.delete(sessionId)
    registryDigests.delete(sessionId)
    await Promise.race([
      current.dispose(),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 3_000)
        timer.unref()
      }),
    ])
  }))
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

// 扩展的异步疏忽（如延迟回调持有 stale ctx）产生的 unhandledRejection：
// 记录并继续，单个扩展的 promise 泄漏不应杀死 worker。
// 但 uncaughtException = 进程级错误，事件循环状态已不可信——硬撑只会让
// worker 变成心跳照发、命令全挂的僵尸，还废掉 server 侧 supervisor 的
// 自愈重建。记录后走有界清理并非零退出，把重建交还给 supervisor。
process.on("unhandledRejection", (reason) => {
  console.error(`[piui-worker] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
})

let fatalExitStarted = false

async function fatalExit(code: number): Promise<void> {
  // 清理本身也可能因进程状态损坏而挂住：3s 后无条件退出
  const force = setTimeout(() => process.exit(code), 3_000)
  force.unref()
  try {
    await cleanupWorker()
  } catch {
    /* best effort */
  }
  process.exit(code)
}

process.on("uncaughtException", (error) => {
  console.error(`[piui-worker] uncaught exception: ${error?.stack ?? error}`)
  if (fatalExitStarted) return
  fatalExitStarted = true
  void fatalExit(1)
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
    // ACK 必须等 IPC flush 完再退出——立刻 process.exit 会砍掉还没发出去
    // 的响应，parent 无法区分「干净关闭」和「清理中途崩溃」（对齐 opencode
    // disposeMiddleware「先回响应再清理」的顺序）。回调不触发时 1s 兜底退出。
    void schedule.close(cleanupWorker).then(
      () => {
        sendWithCallback({ kind: "response", id: request.id, generation: workerGeneration, ok: true }, () => process.exit(0))
        setTimeout(() => process.exit(0), 1_000).unref()
      },
      error => {
        sendWithCallback({
          kind: "response",
          id: request.id,
          generation: workerGeneration,
          ok: false,
          error: problemFromError(error),
        }, () => process.exit(1))
        setTimeout(() => process.exit(1), 1_000).unref()
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
  // parent 已消失，没有任何东西会再来杀这个进程：清理必须在有界时间内
  // 完成，否则 worker 变孤儿。10s（排空 3s + runtime 清理预算）后无条件退出。
  const force = setTimeout(() => process.exit(1), 10_000)
  force.unref()
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
