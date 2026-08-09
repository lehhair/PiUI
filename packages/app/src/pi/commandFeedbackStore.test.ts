import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commandFeedbackStore } from './commandFeedbackStore'

describe('commandFeedbackStore', () => {
  beforeEach(() => commandFeedbackStore.reset())

  it('records entries per session and caps the log length', () => {
    commandFeedbackStore.add({ sessionId: 's1', command: 'compact', status: 'ok', message: 'Context compacted' })
    commandFeedbackStore.add({ sessionId: 's1', command: 'name', args: 'hello', status: 'ok', message: 'Renamed' })
    commandFeedbackStore.add({ sessionId: 's2', command: 'bash', args: 'ls', status: 'error', message: 'boom' })

    const snapshot = commandFeedbackStore.getSnapshot()
    expect(snapshot.sessions['s1']).toHaveLength(2)
    expect(snapshot.sessions['s2']).toHaveLength(1)
    // newest first
    expect(snapshot.sessions['s1']![0]!.command).toBe('name')
    expect(snapshot.sessions['s1']![0]!.args).toBe('hello')
  })

  it('notifies subscribers on add and reset', () => {
    const listener = vi.fn()
    const unsubscribe = commandFeedbackStore.subscribe(listener)
    commandFeedbackStore.add({ sessionId: 's1', command: 'tree', status: 'info', message: 'Opened' })
    expect(listener).toHaveBeenCalledTimes(1)
    commandFeedbackStore.reset()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(commandFeedbackStore.getSnapshot().sessions['s1']).toBeUndefined()
    unsubscribe()
  })
})
