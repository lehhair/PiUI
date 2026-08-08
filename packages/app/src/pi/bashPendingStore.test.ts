import { beforeEach, describe, expect, it } from 'vitest'
import type { PiTimelineItem } from './domain/index.js'
import { bashPendingStore } from './bashPendingStore'

function bashGroup(commands: Array<{ id: string; command: string; timestamp: number }>): PiTimelineItem {
  return {
    kind: 'bash_execution_group',
    entryId: commands[0]!.id,
    timestamp: commands[0]!.timestamp,
    items: commands.map(c => ({
      kind: 'bash_execution',
      entryId: c.id,
      timestamp: c.timestamp,
      rawEntry: {} as never,
      message: {
        role: 'bashExecution',
        command: c.command,
        output: 'out',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: c.timestamp,
      },
    })),
  } as PiTimelineItem
}

describe('bashPendingStore', () => {
  beforeEach(() => {
    bashPendingStore.clearForTest()
  })

  it('creates a pending bash item that renders while executing', () => {
    bashPendingStore.add('s1', 'client-1', 'ls')
    const items = bashPendingStore.toItems([], 's1')
    expect(items).toHaveLength(1)
    expect(items[0]!.entryId).toBe('client-1')
    expect(items[0]!.message.command).toBe('ls')
    // 执行中：无 exitCode（渲染为运行中）
    expect(items[0]!.message.exitCode).toBeUndefined()
  })

  it('hides pending entries once the real entry lands', () => {
    const createdAt = Date.now()
    bashPendingStore.add('s1', 'client-1', 'ls')
    // 真实条目：同一命令、落盘时间晚于乐观条目创建
    const real = bashGroup([{ id: 'real-1', command: 'ls', timestamp: createdAt + 1000 }])
    expect(bashPendingStore.toItems([real], 's1')).toHaveLength(0)
  })

  it('keeps pending visible when a different command lands', () => {
    const createdAt = Date.now()
    bashPendingStore.add('s1', 'client-1', 'npm run build')
    const real = bashGroup([{ id: 'real-1', command: 'ls', timestamp: createdAt + 1000 }])
    const visible = bashPendingStore.toItems([real], 's1')
    expect(visible).toHaveLength(1)
    expect(visible[0]!.message.command).toBe('npm run build')
  })

  it('does not consume pending with historical entries before creation', () => {
    const createdAt = Date.now()
    bashPendingStore.add('s1', 'client-1', 'ls')
    // 历史真实条目（早于乐观条目创建）不应吸收
    const historical = bashGroup([{ id: 'old-1', command: 'ls', timestamp: createdAt - 60_000 }])
    expect(bashPendingStore.toItems([historical], 's1')).toHaveLength(1)
  })

  it('removes consumed pending entries from the store', () => {
    const createdAt = Date.now()
    bashPendingStore.add('s1', 'client-1', 'ls')
    const real = bashGroup([{ id: 'real-1', command: 'ls', timestamp: createdAt + 1000 }])
    bashPendingStore.removeConsumed([real], 's1')
    expect(bashPendingStore.getForSession('s1')).toHaveLength(0)
  })

  it('scopes pending entries per session', () => {
    bashPendingStore.add('s1', 'client-1', 'ls')
    bashPendingStore.add('s2', 'client-2', 'pwd')
    expect(bashPendingStore.toItems([], 's1')).toHaveLength(1)
    expect(bashPendingStore.toItems([], 's2')).toHaveLength(1)
  })
})
