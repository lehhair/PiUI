import { beforeEach, describe, expect, it } from 'vitest'
import { extensionUiStore } from './extensionUiStore'

describe('extensionUiStore', () => {
  beforeEach(() => extensionUiStore.reset())

  it('restores snapshots and settles pending dialogs', () => {
    extensionUiStore.replace({
      sessionId: 'session-1',
      workerGeneration: 'generation-1',
      state: {
        revision: 2,
        statuses: { mode: 'planning' },
        workingVisible: true,
        widgets: {},
        editorText: 'draft',
        toolsExpanded: false,
      },
      pending: [],
    })
    extensionUiStore.requestOpened({
      requestId: 'request-1',
      sessionId: 'session-1',
      workerGeneration: 'generation-1',
      kind: 'select',
      title: 'Mode',
      options: ['plan', 'build'],
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending).toHaveLength(1)
    extensionUiStore.editorCommand('session-1', { kind: 'paste', text: ' more' })
    expect(extensionUiStore.getSnapshot().sessions['session-1']?.state.editorText).toBe('draft more')
    extensionUiStore.requestSettled('session-1', 'request-1')
    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending).toHaveLength(0)
  })
})
