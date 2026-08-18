import type { JsonObject } from "@piui/protocol"

export interface SchedulerCommand {
  type: string
  params?: JsonObject
  sessionId?: string
}

/**
 * 命令调度器：直通模式，语义对齐 pi SDK 原生 RPC（`pi --mode rpc`）。
 *
 * pi 原生 RPC 不排队：每条命令到达即执行，并发约束由 SDK 自己负责——
 * - 流式中 prompt 不带 streamingBehavior → SDK 抛错（客户端用 steer/followUp）
 * - steer/followUp 空闲时 → 消息进队列等下一次 prompt（PiUI 另有 idle 校验）
 * - navigateTree 流式中 → SDK 抛 "Wait for the current response to finish..."
 * - compact 会先 abort 当前回合再压缩
 * - bash 流式中执行 → 结果进 pending 队列，agent_end 时冲刷
 * - newSession/switchSession/fork → teardown 时 dispose 旧会话（中止在途回合）
 *
 * 宿主不再做任何排队/串行/屏障。close() 负责有界排空在途命令（默认 3s）
 * 后执行清理——卡死的命令不能挡住 worker 退出，超时由 runtime.dispose
 * 的 abort 收尾。
 */
export function createWorkerCommandScheduler<T>(
  execute: (command: SchedulerCommand) => Promise<T>,
): ((command: SchedulerCommand) => Promise<T>) & { close: (cleanup: () => Promise<void>) => Promise<void> } {
  let closing = false
  let closePromise: Promise<void> | undefined
  const inFlight = new Set<Promise<unknown>>()

  const schedule = ((command: SchedulerCommand): Promise<T> => {
    if (closing) {
      return Promise.reject(Object.assign(new Error("worker scheduler is closing"), { code: "RUNTIME_CLOSING" }))
    }
    const result = execute(command)
    inFlight.add(result)
    const remove = () => {
      inFlight.delete(result)
    }
    void result.then(remove, remove)
    return result
  }) as ((command: SchedulerCommand) => Promise<T>) & { close: (cleanup: () => Promise<void>) => Promise<void> }

  schedule.close = (cleanup: () => Promise<void>, drainTimeoutMs = 3_000): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    // 有界排空：一条卡死的流式命令（网络挂起、无超时）不应让 worker 永远
    // 退不掉。超时后 cleanup 照跑——runtime.dispose 会 abort 在途回合，
    // 悬空的命令由它们自己的超时/abort 收尾。
    const drained = Promise.allSettled([...inFlight])
    closePromise = Promise.race([
      drained,
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, drainTimeoutMs)
        timer.unref?.()
      }),
    ]).then(async () => {
      await cleanup()
    })
    return closePromise
  }

  return schedule
}
