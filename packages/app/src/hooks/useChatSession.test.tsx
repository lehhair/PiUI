import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatSession } from './useChatSession'
import { setPiCapabilities } from '../pi/capabilities'
import { trackPiSession, untrackPiSession } from '../pi/piSessionIndex'

const {
  createSessionMock,
  compactSessionMock,
  promptSessionMock,
  getSelectableAgentsMock,
  registerSessionConsumerMock,
  updateConsumerSessionIdMock,
  sendNotificationMock,
  isSystemEnabledMock,
  errorHandlerMock,
  getPaneFullAutoModeMock,
  onFullAutoChangeMock,
  autoApproveSubscribeMock,
  shouldAutoApproveMock,
  claimAutoReplyMock,
  releaseAutoReplyMock,
  useSessionFamilyMock,
  pendingPermissionRequestsMock,
  handlePermissionReplyMock,
  refreshPendingRequestsMock,
  useSessionStateMock,
  activeSessionStatusMap,
  forkPiSessionMock,
  applySnapshotToUiMock,
  extractUserMessageContentMock,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  compactSessionMock: vi.fn(),
  promptSessionMock: vi.fn(),
  getSelectableAgentsMock: vi.fn(),
  registerSessionConsumerMock: vi.fn(),
  updateConsumerSessionIdMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  isSystemEnabledMock: vi.fn((type: string) => type !== 'permission'),
  errorHandlerMock: vi.fn(),
  getPaneFullAutoModeMock: vi.fn((_paneId: string) => 'off'),
  onFullAutoChangeMock: vi.fn((_listener: unknown) => vi.fn()),
  autoApproveSubscribeMock: vi.fn((_listener: unknown) => vi.fn()),
  shouldAutoApproveMock: vi.fn((_sessionId: string, _permission: string, _patterns: string[]) => false),
  claimAutoReplyMock: vi.fn((_requestId: string) => true),
  releaseAutoReplyMock: vi.fn((_requestId: string) => undefined),
  useSessionFamilyMock: vi.fn((_sessionId: string | null) => [] as string[]),
  pendingPermissionRequestsMock: [] as Array<{ id: string; sessionID: string; permission: string; patterns?: string[] }>,
  handlePermissionReplyMock: vi.fn(
    (_requestId: string, _reply: string, _directory?: string, _sessionId?: string) => Promise.resolve(true),
  ),
  refreshPendingRequestsMock: vi.fn((_sessionIds?: string | string[], _directory?: string) => Promise.resolve()),
  useSessionStateMock: vi.fn((_sessionId: string | null) => null as null | { isStreaming: boolean; messages: unknown[] }),
  activeSessionStatusMap: {} as Record<string, { type: string; attempt?: number; message?: string; next?: number }>,
  forkPiSessionMock: vi.fn(),
  applySnapshotToUiMock: vi.fn(),
  extractUserMessageContentMock: vi.fn(),
}))

const autoApproveState = vi.hoisted(() => ({
  approvePendingOnFullAuto: false,
}))

vi.mock('../store', () => ({
  messageStore: {
    markAllSessionsStale: vi.fn(),
    getSessionState: vi.fn(() => ({ messages: [] })),
    setStreaming: vi.fn(),
    createSendRollbackSnapshot: vi.fn(),
    truncateAfterRevert: vi.fn(),
    restoreSendRollback: vi.fn(),
    handleMessageUpdated: vi.fn(),
    handlePartUpdated: vi.fn(),
  },
  useSessionFamily: (sessionId: string | null) => useSessionFamilyMock(sessionId),
  useSessionState: (sessionId: string | null) => useSessionStateMock(sessionId),
  autoApproveStore: {
    getPaneFullAutoMode: (paneId: string) => getPaneFullAutoModeMock(paneId),
    onFullAutoChange: (listener: unknown) => onFullAutoChangeMock(listener),
    subscribe: (listener: unknown) => autoApproveSubscribeMock(listener),
    get approvePendingOnFullAuto() {
      return autoApproveState.approvePendingOnFullAuto
    },
    enabled: false,
    shouldAutoApprove: (sessionId: string, permission: string, patterns: string[]) =>
      shouldAutoApproveMock(sessionId, permission, patterns),
    claimAutoReply: (requestId: string) => claimAutoReplyMock(requestId),
    releaseAutoReply: (requestId: string) => releaseAutoReplyMock(requestId),
  },
  childSessionStore: {
    getChildSessionIds: vi.fn(() => []),
    registerChildSession: vi.fn(),
    getSessionAndDescendants: vi.fn(() => []),
  },
  useActiveSessionStore: () => ({ statusMap: activeSessionStatusMap }),
  activeSessionStore: {
    updateStatus: (sessionId: string, status: { type: string }) => {
      if (status.type === 'idle') delete activeSessionStatusMap[sessionId]
      else activeSessionStatusMap[sessionId] = status
    },
  },
}))

vi.mock('../hooks', () => ({
  useSessionManager: () => ({
    loadSession: vi.fn(),
    loadMoreHistory: vi.fn(),
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    handleRedoAll: vi.fn(),
    clearRevert: vi.fn(),
  }),
  registerSessionConsumer: (...args: unknown[]) => registerSessionConsumerMock(...args),
  updateConsumerSessionId: (...args: unknown[]) => updateConsumerSessionIdMock(...args),
  hasOtherConsumerForSession: vi.fn(() => false),
  usePermissions: () => ({ resetPermissions: vi.fn() }),
  usePermissionHandler: () => ({
    pendingPermissionRequests: pendingPermissionRequestsMock,
    pendingQuestionRequests: [],
    setPendingPermissionRequests: vi.fn(),
    setPendingQuestionRequests: vi.fn(),
    handlePermissionReply: handlePermissionReplyMock,
    handleQuestionReply: vi.fn(),
    handleQuestionReject: vi.fn(),
    refreshPendingRequests: refreshPendingRequestsMock,
    resetPendingRequests: vi.fn(),
    isReplying: false,
  }),
  useMessageAnimation: () => ({
    registerMessage: vi.fn(),
    registerInputBox: vi.fn(),
    animateUndo: vi.fn(),
    animateRedo: vi.fn(),
  }),
  useDirectory: () => ({ currentDirectory: '/workspace/demo' }),
  useSessionContext: () => ({
    createSession: createSessionMock,
    sessions: [],
  }),
}))

vi.mock('./useNotification', () => ({
  useNotification: () => ({ sendNotification: sendNotificationMock }),
}))

vi.mock('../store/notificationEventSettingsStore', () => ({
  notificationEventSettingsStore: {
    isSystemEnabled: (type: string) => isSystemEnabledMock(type),
  },
}))

vi.mock('../api', () => ({
  abortSession: vi.fn(),
  getSelectableAgents: (...args: unknown[]) => getSelectableAgentsMock(...args),
  getPendingPermissions: vi.fn(() => Promise.resolve([])),
  getPendingQuestions: vi.fn(() => Promise.resolve([])),
  prefetchCommands: vi.fn(() => Promise.resolve()),
  prefetchRootDirectory: vi.fn(() => Promise.resolve()),
  getSessionChildren: vi.fn(() => Promise.resolve([])),
  updateSession: vi.fn(),
  forkSession: vi.fn(),
  extractUserMessageContent: extractUserMessageContentMock,
}))

vi.mock('../pi/sessionApi', () => ({
  promptSession: (...args: unknown[]) => promptSessionMock(...args),
  compactSession: (...args: unknown[]) => compactSessionMock(...args),
  abortSessionCommand: vi.fn(),
  forkPiSession: (...args: unknown[]) => forkPiSessionMock(...args),
}))

vi.mock('../pi/applySnapshot', () => ({ applySnapshotToUi: applySnapshotToUiMock }))

vi.mock('../pi/eventSocket', () => ({ ensurePiEventSocket: vi.fn() }))

vi.mock('../utils', () => ({
  clipboardErrorHandler: vi.fn(),
  copyTextToClipboard: vi.fn(),
  createErrorHandler: vi.fn(() => errorHandlerMock),
}))

vi.mock('../utils/perServerStorage', () => ({
  serverStorage: {
    get: vi.fn(() => 'build'),
    set: vi.fn(),
  },
}))

describe('useChatSession handleCommand', () => {
  beforeEach(() => {
    createSessionMock.mockReset()
    compactSessionMock.mockReset()
    promptSessionMock.mockReset()
    getSelectableAgentsMock.mockReset()
    registerSessionConsumerMock.mockReset()
    updateConsumerSessionIdMock.mockReset()
    sendNotificationMock.mockReset()
    isSystemEnabledMock.mockReset()
    errorHandlerMock.mockReset()
    getPaneFullAutoModeMock.mockReset()
    onFullAutoChangeMock.mockReset()
    autoApproveSubscribeMock.mockReset()
    shouldAutoApproveMock.mockReset()
    claimAutoReplyMock.mockReset()
    releaseAutoReplyMock.mockReset()
    useSessionFamilyMock.mockReset()
    handlePermissionReplyMock.mockReset()
    refreshPendingRequestsMock.mockReset()
    useSessionStateMock.mockReset()
    forkPiSessionMock.mockReset()
    applySnapshotToUiMock.mockReset()
    extractUserMessageContentMock.mockReset()
    pendingPermissionRequestsMock.length = 0
    for (const key of Object.keys(activeSessionStatusMap)) {
      delete activeSessionStatusMap[key]
    }

    registerSessionConsumerMock.mockReturnValue(vi.fn())
    getPaneFullAutoModeMock.mockReturnValue('off')
    onFullAutoChangeMock.mockReturnValue(vi.fn())
    autoApproveSubscribeMock.mockReturnValue(vi.fn())
    shouldAutoApproveMock.mockReturnValue(false)
    claimAutoReplyMock.mockReturnValue(true)
    useSessionFamilyMock.mockReturnValue([])
    useSessionStateMock.mockReturnValue(null)
    handlePermissionReplyMock.mockResolvedValue(true)
    refreshPendingRequestsMock.mockResolvedValue(undefined)
    autoApproveState.approvePendingOnFullAuto = false
    getSelectableAgentsMock.mockResolvedValue([{ name: 'build', mode: 'primary', hidden: false }])
    isSystemEnabledMock.mockImplementation((type: string) => type !== 'permission')
    setPiCapabilities(undefined)

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => window.setTimeout(() => cb(0), 16))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('dispatches compact through Pi before it finishes', async () => {
    compactSessionMock.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() =>
      useChatSession({
        paneId: 'pane-1',
        chatAreaRef: { current: null },
        currentModel: { id: 'model-1', providerId: 'provider-1', variants: [] } as never,
        refetchModels: vi.fn(async () => {}),
        sessionId: 'session-1',
        navigateToSession: vi.fn(),
        navigateHome: vi.fn(),
      }),
    )

    let settled = false
    let commandResult: boolean | undefined

    await act(async () => {
      const promise = result.current.handleCommand('/compact')
      promise.then(value => {
        settled = true
        commandResult = value
      })
      await Promise.resolve()
    })

    expect(compactSessionMock).toHaveBeenCalledWith('session-1')
    expect(settled).toBe(true)
    expect(commandResult).toBe(true)
  })

  it('dispatches native slash commands through Pi prompt', async () => {
    promptSessionMock.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() =>
      useChatSession({
        paneId: 'pane-1',
        chatAreaRef: { current: null },
        currentModel: { id: 'model-1', providerId: 'provider-1', variants: [] } as never,
        refetchModels: vi.fn(async () => {}),
        sessionId: 'session-1',
        navigateToSession: vi.fn(),
        navigateHome: vi.fn(),
      }),
    )

    let settled = false
    let commandResult: boolean | undefined

    await act(async () => {
      const promise = result.current.handleCommand('/review src/App.tsx')
      promise.then(value => {
        settled = true
        commandResult = value
      })
      await Promise.resolve()
    })

    expect(promptSessionMock).toHaveBeenCalledWith(
      'session-1',
      '/review src/App.tsx',
      expect.objectContaining({ stream: true }),
    )
    expect(activeSessionStatusMap['session-1']).toEqual({ type: 'busy' })
    expect(settled).toBe(true)
    expect(commandResult).toBe(true)
  })

  it('forks a Pi user entry before the message and navigates only this pane to the target', async () => {
    const sourceSnapshot = { session: { id: 'session-1' } }
    const targetSnapshot = { session: { id: 'session-2' } }
    const navigateToSession = vi.fn()
    trackPiSession('session-1', 'workspace-1')
    setPiCapabilities({ fork: true })
    extractUserMessageContentMock.mockReturnValue({ text: 'original prompt', attachments: [] })
    forkPiSessionMock.mockResolvedValue({
      replacement: {
        sourceSessionId: 'session-1',
        targetSessionId: 'session-2',
        targetCwd: '/workspace/fork',
        selectedText: 'editable prompt',
        cancelled: false,
      },
      sourceSnapshot,
      targetSnapshot,
    })

    let activeSessionId = 'session-1'
    const { result, rerender } = renderHook(() =>
      useChatSession({
        paneId: 'pane-1',
        chatAreaRef: { current: null },
        currentModel: { id: 'model-1', providerId: 'provider-1', variants: [] } as never,
        refetchModels: vi.fn(async () => {}),
        sessionId: activeSessionId,
        navigateToSession,
        navigateHome: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.handleForkMessage({
        info: {
          id: 'message-1',
          entryId: 'entry-1',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'provider-1', modelID: 'model-1' },
        },
        parts: [],
      })
    })

    expect(forkPiSessionMock).toHaveBeenCalledWith('session-1', 'entry-1', 'before')
    expect(applySnapshotToUiMock).toHaveBeenNthCalledWith(1, sourceSnapshot, { activate: false })
    expect(applySnapshotToUiMock).toHaveBeenNthCalledWith(2, targetSnapshot)
    expect(navigateToSession).toHaveBeenCalledWith('session-2', '/workspace/fork')
    activeSessionId = 'session-2'
    rerender()
    expect(result.current.restoredContent?.text).toBe('editable prompt')
    untrackPiSession('session-1')
  })

  it('restores text in the submitting pane when an accepted Pi command fails asynchronously', async () => {
    trackPiSession('session-1', 'workspace-1')
    promptSessionMock.mockResolvedValue({ accepted: true })
    const { result } = renderHook(() =>
      useChatSession({
        paneId: 'pane-1',
        chatAreaRef: { current: null },
        currentModel: { id: 'model-1', providerId: 'provider-1', variants: [] } as never,
        refetchModels: vi.fn(async () => {}),
        sessionId: 'session-1',
        navigateToSession: vi.fn(),
        navigateHome: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.handleSend('keep this correction', [], {})
    })
    const commandId = promptSessionMock.mock.calls[0]?.[2]?.commandId
    expect(commandId).toBeTruthy()

    act(() => {
      window.dispatchEvent(new CustomEvent('piui:command-updated', {
        detail: {
          commandId,
          sessionId: 'session-1',
          commandType: 'session.prompt',
          inputText: 'keep this correction',
          status: 'failed',
          error: { message: 'session stopped' },
        },
      }))
    })

    expect(result.current.restoredContent?.text).toBe('keep this correction')
    expect(errorHandlerMock).toHaveBeenCalled()
    untrackPiSession('session-1')
  })

  it('forks a merged assistant turn at its final native entry', async () => {
    const firstAssistant = {
      info: {
        id: 'assistant-1',
        entryId: 'entry-assistant-1',
        sessionID: 'session-1',
        role: 'assistant' as const,
        time: { created: 1 },
        parentID: 'user-1',
        modelID: 'model-1',
        providerID: 'provider-1',
        mode: 'chat',
        agent: 'build',
        path: { cwd: '/workspace/demo', root: '/workspace/demo' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    }
    const finalAssistant = {
      ...firstAssistant,
      info: { ...firstAssistant.info, id: 'assistant-2', entryId: 'entry-assistant-2' },
    }
    useSessionStateMock.mockReturnValue({
      isStreaming: false,
      messages: [firstAssistant, finalAssistant],
    })
    trackPiSession('session-1', 'workspace-1')
    setPiCapabilities({ fork: true })
    forkPiSessionMock.mockResolvedValue({
      replacement: {
        sourceSessionId: 'session-1',
        targetSessionId: 'session-2',
        cancelled: false,
      },
      sourceSnapshot: { session: { id: 'session-1' } },
      targetSnapshot: { session: { id: 'session-2' } },
    })
    const { result } = renderHook(() =>
      useChatSession({
        paneId: 'pane-1',
        chatAreaRef: { current: null },
        currentModel: { id: 'model-1', providerId: 'provider-1', variants: [] } as never,
        refetchModels: vi.fn(async () => {}),
        sessionId: 'session-1',
        navigateToSession: vi.fn(),
        navigateHome: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.handleForkMessage(firstAssistant, 'assistant-2')
    })

    expect(forkPiSessionMock).toHaveBeenCalledWith('session-1', 'entry-assistant-2', 'at')
    untrackPiSession('session-1')
  })

  it('does not poll permissions when session full auto pending sweep is enabled', async () => {
    getPaneFullAutoModeMock.mockReturnValue('session')
    autoApproveState.approvePendingOnFullAuto = true
    useSessionFamilyMock.mockReturnValue(['session-1', 'child-session'])

    renderHook(() =>
      useChatSession({
        paneId: 'pane-1',
        chatAreaRef: { current: null },
        currentModel: { id: 'model-1', providerId: 'provider-1', variants: [] } as never,
        refetchModels: vi.fn(async () => {}),
        sessionId: 'session-1',
        navigateToSession: vi.fn(),
        navigateHome: vi.fn(),
      }),
    )

    await Promise.resolve()
    expect(refreshPendingRequestsMock).not.toHaveBeenCalled()
  })

  it('approves already pending permissions when session full auto pending sweep is enabled', async () => {
    getPaneFullAutoModeMock.mockReturnValue('session')
    autoApproveState.approvePendingOnFullAuto = true
    pendingPermissionRequestsMock.push({
      id: 'perm-1',
      sessionID: 'session-1',
      permission: 'bash',
      patterns: ['npm test'],
    })

    renderHook(() =>
      useChatSession({
        paneId: 'pane-1',
        chatAreaRef: { current: null },
        currentModel: { id: 'model-1', providerId: 'provider-1', variants: [] } as never,
        refetchModels: vi.fn(async () => {}),
        sessionId: 'session-1',
        navigateToSession: vi.fn(),
        navigateHome: vi.fn(),
      }),
    )

    await waitFor(() => {
      expect(claimAutoReplyMock).toHaveBeenCalledWith('perm-1')
      expect(handlePermissionReplyMock).toHaveBeenCalledWith('perm-1', 'once', '/workspace/demo', 'session-1')
    })
  })

  it.each([
    {
      disabledType: 'permission',
      trigger: 'onPermissionAsked',
      payload: { id: 'perm-1', sessionID: 'session-1', permission: 'bash', patterns: [] },
    },
    {
      disabledType: 'question',
      trigger: 'onQuestionAsked',
      payload: {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [{ header: 'Need input' }],
      },
    },
    {
      disabledType: 'completed',
      trigger: 'onSessionIdle',
      payload: 'session-1',
    },
    {
      disabledType: 'error',
      trigger: 'onSessionError',
      payload: 'session-1',
    },
  ])(
    'does not send browser notification when the $disabledType event is disabled',
    async ({ disabledType, trigger, payload }) => {
      let callbacks: Record<string, ((payload: unknown) => void) | undefined> | undefined
      registerSessionConsumerMock.mockImplementation((_paneId, _sessionId, consumerCallbacks) => {
        callbacks = consumerCallbacks as typeof callbacks
        return vi.fn()
      })
      isSystemEnabledMock.mockImplementation((type: string) => type !== disabledType)

      renderHook(() =>
        useChatSession({
          paneId: 'pane-1',
          chatAreaRef: { current: null },
          currentModel: { id: 'model-1', providerId: 'provider-1', variants: [] } as never,
          refetchModels: vi.fn(async () => {}),
          sessionId: 'session-1',
          navigateToSession: vi.fn(),
          navigateHome: vi.fn(),
        }),
      )

      act(() => {
        callbacks?.[trigger]?.(payload)
      })

      expect(sendNotificationMock).not.toHaveBeenCalled()
    },
  )
})

describe('useChatSession busy UI signal', () => {
  beforeEach(() => {
    createSessionMock.mockReset()
    compactSessionMock.mockReset()
    promptSessionMock.mockReset()
    getSelectableAgentsMock.mockReset()
    registerSessionConsumerMock.mockReset()
    updateConsumerSessionIdMock.mockReset()
    sendNotificationMock.mockReset()
    isSystemEnabledMock.mockReset()
    errorHandlerMock.mockReset()
    getPaneFullAutoModeMock.mockReset()
    onFullAutoChangeMock.mockReset()
    autoApproveSubscribeMock.mockReset()
    shouldAutoApproveMock.mockReset()
    claimAutoReplyMock.mockReset()
    releaseAutoReplyMock.mockReset()
    useSessionFamilyMock.mockReset()
    handlePermissionReplyMock.mockReset()
    refreshPendingRequestsMock.mockReset()
    useSessionStateMock.mockReset()
    pendingPermissionRequestsMock.length = 0
    for (const key of Object.keys(activeSessionStatusMap)) {
      delete activeSessionStatusMap[key]
    }

    registerSessionConsumerMock.mockReturnValue(vi.fn())
    getPaneFullAutoModeMock.mockReturnValue('off')
    onFullAutoChangeMock.mockReturnValue(vi.fn())
    autoApproveSubscribeMock.mockReturnValue(vi.fn())
    shouldAutoApproveMock.mockReturnValue(false)
    claimAutoReplyMock.mockReturnValue(true)
    useSessionFamilyMock.mockReturnValue([])
    useSessionStateMock.mockReturnValue(null)
    handlePermissionReplyMock.mockResolvedValue(true)
    refreshPendingRequestsMock.mockResolvedValue(undefined)
    autoApproveState.approvePendingOnFullAuto = false
    getSelectableAgentsMock.mockResolvedValue([{ name: 'build', mode: 'primary', hidden: false }])
    isSystemEnabledMock.mockImplementation((type: string) => type !== 'permission')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps UI isStreaming true from session.status when message streaming is false', () => {
    useSessionStateMock.mockReturnValue({ isStreaming: false, messages: [] })
    activeSessionStatusMap['session-1'] = { type: 'busy' }

    const { result } = renderHook(() =>
      useChatSession({
        paneId: 'pane-1',
        chatAreaRef: { current: null },
        currentModel: { id: 'model-1', providerId: 'provider-1', variants: [] } as never,
        refetchModels: vi.fn(async () => {}),
        sessionId: 'session-1',
        navigateToSession: vi.fn(),
        navigateHome: vi.fn(),
      }),
    )

    expect(result.current.isStreaming).toBe(true)
    expect(result.current.messageIsStreaming).toBe(false)
  })

  it('keeps UI isStreaming true while session is in retry between agent steps', () => {
    useSessionStateMock.mockReturnValue({ isStreaming: false, messages: [] })
    activeSessionStatusMap['session-1'] = {
      type: 'retry',
      attempt: 1,
      message: 'retrying',
      next: Date.now() + 1000,
    }

    const { result } = renderHook(() =>
      useChatSession({
        paneId: 'pane-1',
        chatAreaRef: { current: null },
        currentModel: { id: 'model-1', providerId: 'provider-1', variants: [] } as never,
        refetchModels: vi.fn(async () => {}),
        sessionId: 'session-1',
        navigateToSession: vi.fn(),
        navigateHome: vi.fn(),
      }),
    )

    expect(result.current.isStreaming).toBe(true)
    expect(result.current.messageIsStreaming).toBe(false)
    expect(result.current.retryStatus?.attempt).toBe(1)
  })

  it('falls back to message streaming when session status is idle', () => {
    useSessionStateMock.mockReturnValue({ isStreaming: true, messages: [] })

    const { result } = renderHook(() =>
      useChatSession({
        paneId: 'pane-1',
        chatAreaRef: { current: null },
        currentModel: { id: 'model-1', providerId: 'provider-1', variants: [] } as never,
        refetchModels: vi.fn(async () => {}),
        sessionId: 'session-1',
        navigateToSession: vi.fn(),
        navigateHome: vi.fn(),
      }),
    )

    expect(result.current.isStreaming).toBe(true)
    expect(result.current.messageIsStreaming).toBe(true)
  })
})
