import { afterEach, describe, expect, it } from 'vitest'
import type { CommandRecord } from '@piui/protocol'
import { piCommandStore } from './piCommandStore.js'

function command(overrides: Partial<CommandRecord> = {}): CommandRecord {
  return {
    id: 'command-1',
    type: 'prompt',
    sessionId: 'session-1',
    status: 'accepted',
    submittedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('piCommandStore', () => {
  afterEach(() => piCommandStore.clearAll())

  it('updates one command from accepted to its terminal state', () => {
    piCommandStore.upsert(command())
    piCommandStore.upsert(command({ status: 'completed', completedAt: '2026-01-01T00:00:01.000Z' }))

    expect(piCommandStore.get('command-1')?.status).toBe('completed')
    expect(piCommandStore.getSnapshot()).toHaveLength(1)
  })

  it('clears commands for a replaced session without touching other sessions', () => {
    piCommandStore.upsert(command())
    piCommandStore.upsert(command({ id: 'command-2', sessionId: 'session-2' }))

    piCommandStore.clearSession('session-1')

    expect(piCommandStore.get('command-1')).toBeNull()
    expect(piCommandStore.getForSession('session-2')).toHaveLength(1)
  })
})
