/** PiUI backend bootstrap. */
import { getPiBackendState, setPiBackendState } from "./serverMode"
import { serverStore } from "../store/serverStore"
import { clearPiSessionIndex } from "./piSessionIndex"
import { piBranchStore, piModelsStore, piSessionStateStore } from "./state/index.js"
import { piSessionInfoStore } from "./piSessionInfoStore"
import { extensionUiStore } from "./extensionUiStore"
import { extensionTuiStore } from "./extensionTuiStore"
import { commandFeedbackStore } from "./commandFeedbackStore"
import { resetWorkspaceResolutionCache } from "./workspaces"
import { clearAllWorkspaceFileCaches } from "./files"
import { clearPiTimelineItemCache } from "./selectors/timelineCache"
import { resetManagementEvents } from "./managementEventStore"
import { refreshPiNativeStatus } from "./nativeStatus"
import { piEventStream } from "./eventStream"
import { abortInFlightPiRequests } from "./httpClient"
import { activeSessionStore } from "../store/activeSessionStore"
import { PROTOCOL_VERSION } from "@piui/protocol"

export interface PiBackendBootstrapResult {
  available: boolean
  driver?: "mock" | "pi"
}

let initialization: Promise<PiBackendBootstrapResult> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let serverSwitchInstalled = false

export async function initializePiBackend(): Promise<PiBackendBootstrapResult> {
  if (initialization) return initialization
  initialization = initializePiBackendOnce().finally(() => { initialization = null })
  return initialization
}

async function initializePiBackendOnce(): Promise<PiBackendBootstrapResult> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  setPiBackendState({ ...getPiBackendState(), status: "booting", error: undefined })
  try {
    // 预算 5s：registry 在 server 侧是静态快照（不等 worker），正常毫秒级；
    // 宽松预算只为覆盖冷机器的进程调度/杀软抖动，不再为 worker 冷启动买单。
    const native = await refreshPiNativeStatus(AbortSignal.timeout(5000))
    if (serverStore.getActiveServerGeneration() !== serverGeneration) return { available: false }
    const driver = native.registry?.driver
    if (native.status !== "online" && native.status !== "degraded") {
      throw new Error(native.error ?? "PiUI backend unavailable")
    }
    if (native.health?.service !== "piui-server" || native.health.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("unexpected backend")
    }

    setPiBackendState({
      status: "online",
      driver,
      checkedAt: Date.now(),
    })
    console.info("[PiUI] server up, driver=", driver ?? "unknown")
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    return { available: true, driver }
  } catch (error) {
    if (serverStore.getActiveServerGeneration() !== serverGeneration) return { available: false }
    const message = error instanceof Error ? error.message : String(error)
    setPiBackendState({
      status: /\b(401|403)\b/.test(message) ? "unauthorized" : "offline",
      error: message,
      checkedAt: Date.now(),
    })
    if (import.meta.env.DEV) {
      console.info("[PiUI] server not up — run npm run dev:server or npm run dev:server:pi")
      if (error instanceof Error) console.info("[PiUI] backend bootstrap:", error.message)
    }
    scheduleBackendRetry()
    return { available: false }
  }
}

export function installPiBackendServerSwitch(): void {
  if (serverSwitchInstalled) return
  serverSwitchInstalled = true
  serverStore.onServerChange(() => {
    abortInFlightPiRequests()
    clearPiSessionIndex()
    clearPiTimelineItemCache()
    piBranchStore.clearAll()
    piSessionStateStore.clearAll()
    piModelsStore.clear()
    piSessionInfoStore.clear()
    extensionUiStore.reset()
    extensionTuiStore.reset()
    commandFeedbackStore.reset()
    activeSessionStore.reset()
    resetWorkspaceResolutionCache()
    clearAllWorkspaceFileCaches()
    resetManagementEvents()
    setPiBackendState({ status: "booting" })
    piEventStream.disconnectAll()
    void initializePiBackend().then(() => {
      // A switch can arrive while an older bootstrap promise is still active.
      // Re-run against the newly selected server once that promise is released.
      if (getPiBackendState().status === "booting") void initializePiBackend()
    })
  })
}

function scheduleBackendRetry(): void {
  if (retryTimer || typeof window === "undefined") return
  // 固定 1s 间隔重试，不用指数退避：server 冷启动（exe 加载 + worker SDK
  // 预热）本身就要秒级，指数退避会把「服务刚好就绪」到「UI 发现它」之间
  // 再人为塞进一段退避窗口（最坏 30s），可感知的可用时间被无谓拉长。
  retryTimer = setTimeout(() => {
    retryTimer = null
    void initializePiBackend()
  }, 1_000)
}
