import { useSyncExternalStore } from 'react'

/**
 * 运行中工具（bash 等）的实时输出，按 toolCallId 键控（Pi 生成的 UUID 全局
 * 唯一，无需 session 维度）。Pi 的 tool_execution_update.partialResult 是
 * 累积输出（不是增量），直接替换显示即可；tool_execution_end 时清除。
 */

interface LiveToolOutputEntry {
  sessionId: string
  text: string
}

const outputs = new Map<string, LiveToolOutputEntry>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** 从 Pi partialResult.content 提取全部文本块（纯函数，可单测） */
export function extractToolExecutionText(partialResult: { content?: unknown } | undefined): string {
  if (!partialResult || !Array.isArray(partialResult.content)) return ''
  return partialResult.content
    .filter((block): block is { type: 'text'; text: string } => (
      Boolean(block) && typeof block === 'object' && !Array.isArray(block)
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map(block => block.text)
    .join('')
}

export const liveToolOutputStore = {
  set(toolCallId: string, sessionId: string, text: string): void {
    const previous = outputs.get(toolCallId)
    if (previous && previous.text === text) return
    outputs.set(toolCallId, { sessionId, text })
    notify()
  },
  /** 追加增量输出（用户 `!cmd` 的 bash_execution_update.delta 是 chunk） */
  append(toolCallId: string, sessionId: string, delta: string): void {
    if (!delta) return
    const previous = outputs.get(toolCallId)
    outputs.set(toolCallId, { sessionId, text: (previous?.text ?? '') + delta })
    notify()
  },
  delete(toolCallId: string): void {
    if (!outputs.delete(toolCallId)) return
    notify()
  },
  clearSession(sessionId: string): void {
    let changed = false
    for (const [toolCallId, entry] of outputs) {
      if (entry.sessionId === sessionId) {
        outputs.delete(toolCallId)
        changed = true
      }
    }
    if (changed) notify()
  },
  get(toolCallId: string): string | undefined {
    return outputs.get(toolCallId)?.text
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  clearAll(): void {
    outputs.clear()
    notify()
  },
}

/** 订阅某工具调用的实时输出；无输出或非运行中时返回 undefined */
export function useLiveToolOutput(toolCallId: string | undefined): string | undefined {
  return useSyncExternalStore(
    liveToolOutputStore.subscribe,
    () => (toolCallId ? liveToolOutputStore.get(toolCallId) : undefined),
  )
}
