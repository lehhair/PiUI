import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionUiDialogRequest, JsonObject } from '@piui/protocol'
import { extensionUiStore } from '../extensionUiStore.js'
import { activeSessionStore } from '../../store/activeSessionStore.js'
import { piSessionStateStore } from './piSessionStateStore.js'

function dialogRequest(overrides: Partial<ExtensionUiDialogRequest> = {}): ExtensionUiDialogRequest {
  return {
    requestId: 'dialog-1',
    sessionId: 'session-1',
    workerGeneration: 'gen-1',
    kind: 'confirm',
    title: 'Allow?',
    message: 'Proceed?',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ExtensionUiDialogRequest
}

function stateWith(pending: unknown): JsonObject {
  return { sessionId: 'session-1', isStreaming: false, pendingExtensionUiRequests: pending } as unknown as JsonObject
}

describe('piSessionStateStore pending dialog recovery', () => {
  afterEach(() => {
    piSessionStateStore.clearAll()
    extensionUiStore.reset()
    activeSessionStore.reset()
  })

  it('restores pending dialogs from state.get after a refresh', () => {
    piSessionStateStore.setState('session-1', stateWith([dialogRequest()]))

    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending).toHaveLength(1)
    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending[0]?.requestId).toBe('dialog-1')
    const busy = activeSessionStore.getBusySessionsSnapshot()
    expect(busy.some(entry => entry.sessionId === 'session-1' && entry.pendingAction?.type === 'permission')).toBe(true)
  })

  it('does not restore for another session or when absent', () => {
    piSessionStateStore.setState('session-1', stateWith([dialogRequest()]))
    piSessionStateStore.setState('session-2', stateWith(undefined))

    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending).toHaveLength(1)
    expect(extensionUiStore.getSnapshot().sessions['session-2']?.pending ?? []).toHaveLength(0)
  })

  it('is idempotent across repeated state refreshes (live event + recovery overlap)', () => {
    const request = dialogRequest()
    // Live event already rendered the dialog; recovery must not duplicate it.
    extensionUiStore.requestOpened(request)
    activeSessionStore.addPendingRequest(request.requestId, 'session-1', 'permission', request.title)

    piSessionStateStore.setState('session-1', stateWith([request]))
    piSessionStateStore.setState('session-1', stateWith([request]))

    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending).toHaveLength(1)
    expect(activeSessionStore.getBusySessionsSnapshot().some(entry => entry.sessionId === 'session-1')).toBe(true)
  })

  it('skips malformed entries', () => {
    piSessionStateStore.setState('session-1', stateWith([{ requestId: 42 }, null, 'x']))

    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending ?? []).toHaveLength(0)
  })
})
