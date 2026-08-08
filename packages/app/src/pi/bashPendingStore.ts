import type { PiBashExecutionItem, PiTimelineItem } from './domain/index.js'

/**
 * 用户发起的 bash（`!cmd` / `/bash cmd`）乐观条目。
 *
 * pi TUI 的做法：执行开始立即创建 BashExecutionComponent 显示 "Running"，
 * executeBash 的 onChunk 回调实时 appendOutput，完成后 setComplete。
 * Web 版无法直接拿 onChunk（worker 隔离），等价映射：
 * - 发送命令时在此登记一个"执行中"的乐观条目（前端立即显示，isActive）
 * - worker 透传的 clientId 使 SDK 的 bash_execution_update.delta 能关联到
 *   该条目（经 liveToolOutputStore 累积，BashRenderer 实时显示）
 * - 真实条目（recordBashResult 落盘）出现后，乐观条目被"吸收"移除
 */

export interface PendingBash {
  sessionId: string
  /** 前端生成的关联键：透传给 worker 作为 bash_execution_update.id */
  clientId: string
  command: string
  createdAt: number
}

const pendings: PendingBash[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** 收集 timeline 里真实落盘的 bash 条目（组内逐个展开） */
function collectRealBashEntries(items: PiTimelineItem[]): Array<{ command: string; timestamp: number }> {
  const result: Array<{ command: string; timestamp: number }> = []
  for (const item of items) {
    if (item.kind === 'bash_execution') {
      result.push({ command: item.message.command, timestamp: item.timestamp })
    } else if (item.kind === 'bash_execution_group') {
      for (const bashItem of item.items) {
        result.push({ command: bashItem.message.command, timestamp: bashItem.timestamp })
      }
    }
  }
  return result
}

export const bashPendingStore = {
  add(sessionId: string, clientId: string, command: string): void {
    pendings.push({ sessionId, clientId, command, createdAt: Date.now() })
    notify()
  },

  remove(clientId: string): void {
    const index = pendings.findIndex(pending => pending.clientId === clientId)
    if (index === -1) return
    pendings.splice(index, 1)
    notify()
  },

  /** 该会话当前未完成的乐观 bash（执行中仍显示的） */
  getForSession(sessionId: string): PendingBash[] {
    return pendings.filter(pending => pending.sessionId === sessionId)
  },

  /**
   * 已被真实条目吸收（命令相同且落盘时间晚于乐观条目创建）的乐观条目。
   * pi TUI 的 setComplete → 会话历史落盘，等价于真实条目接管显示。
   */
  removeConsumed(items: PiTimelineItem[], sessionId: string): void {
    const real = collectRealBashEntries(items)
    let changed = false
    for (let i = pendings.length - 1; i >= 0; i -= 1) {
      const pending = pendings[i]!
      if (pending.sessionId !== sessionId) continue
      const matched = real.some(entry =>
        entry.command === pending.command && entry.timestamp > pending.createdAt)
      if (matched) {
        pendings.splice(i, 1)
        changed = true
      }
    }
    if (changed) notify()
  },

  /** 供渲染合并：把未完成的乐观条目转成可渲染的 bash_execution item */
  toItems(items: PiTimelineItem[], sessionId: string): PiBashExecutionItem[] {
    const real = collectRealBashEntries(items)
    return pendings
      .filter(pending => pending.sessionId === sessionId)
      .filter(pending => !real.some(entry =>
        entry.command === pending.command && entry.timestamp > pending.createdAt))
      .map(pending => ({
        kind: 'bash_execution',
        entryId: pending.clientId,
        timestamp: pending.createdAt,
        rawEntry: {
          type: 'message',
          id: pending.clientId,
          parentId: null,
          timestamp: new Date(pending.createdAt).toISOString(),
          message: {
            role: 'bashExecution',
            command: pending.command,
            output: '',
            exitCode: undefined,
            cancelled: false,
            truncated: false,
            timestamp: pending.createdAt,
          },
        },
        message: {
          role: 'bashExecution',
          command: pending.command,
          output: '',
          exitCode: undefined,
          cancelled: false,
          truncated: false,
          timestamp: pending.createdAt,
        },
      }) satisfies PiBashExecutionItem)
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /** 仅供测试 */
  clearForTest(): void {
    pendings.length = 0
    notify()
  },
}
