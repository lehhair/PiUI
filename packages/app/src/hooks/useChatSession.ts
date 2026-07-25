// ============================================
// useChatSession - 聊天会话管理
// ============================================

import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  messageStore,
  useSessionState,
  autoApproveStore,
  useActiveSessionStore,
  type RevertHistoryItem,
} from '../store'
import {
  useSessionManager,
  registerSessionConsumer,
  updateConsumerSessionId,
  hasOtherConsumerForSession,
} from '../hooks'
import { usePermissions, usePermissionHandler, useMessageAnimation, useDirectory, useSessionContext } from '../hooks'
import { useNotification } from './useNotification'
import { notificationEventSettingsStore } from '../store/notificationEventSettingsStore'
import {
  prefetchCommands,
  updateSession,
  forkSession,
  extractUserMessageContent,
  type ApiPermissionRequest,
  type ApiAgent,
  type Attachment,
} from '../api'
import type { UiSession } from '../types/session'
import type { ModelInfo } from './useModels'
import { getMessageText, isUserMessage, type AssistantMessageInfo, type Message as UIMessage } from '../types/message'
import { clipboardErrorHandler, copyTextToClipboard, createErrorHandler } from '../utils'
import { clearSessionRuntimeState } from '../utils/sessionLifecycle'
import { serverStorage } from '../utils/perServerStorage'
import { STORAGE_KEY_SELECTED_AGENT } from '../constants'
import type { ChatAreaHandle } from '../features/chat'
import { isPiSession } from '../pi/isPiSession'
import { promptSession } from '../pi/sessionApi'
import { forkPiSession } from '../pi/sessionApi'
import { applySnapshotToUi } from '../pi/applySnapshot'
import { followupQueueStore, useFollowupQueue } from '../store/followupQueueStore'
import { usePiCapabilities } from '../pi/capabilities'
import { clearSessionEditorDraft, useSessionEditorDraft } from '../pi/sessionEditorDraftStore'
import { sessionProjectionStore } from '../pi/sessionProjectionStore'

const handleError = createErrorHandler('session')

/**
 * Stable empty session state singleton.
 *
 * When routeSessionId is null (e.g. an empty split pane), useChatSession
 * uses this instead of creating a new object on every render.  A fresh
 * literal `{ messages: [], ... }` would give a different reference each
 * time, defeating React.memo on ChatArea and causing pointless re-renders
 * of the entire message tree.
 */
const EMPTY_SESSION_STATE = {
  messages: [] as import('../types/message').Message[],
  isStreaming: false,
  loadState: 'idle' as const,
  loadError: undefined,
  revertState: null,
  canUndo: false,
  canRedo: false,
  redoSteps: 0,
  revertedContent: null,
  hasMoreHistory: false,
  directory: '',
  title: null,
} as const

interface UseChatSessionOptions {
  paneId: string
  chatAreaRef: React.RefObject<ChatAreaHandle | null>
  currentModel: ModelInfo | undefined
  refetchModels: () => Promise<void>
  sessionId: string | null
  navigateToSession: (sessionId: string, directory?: string) => void
  navigateHome: () => void
}

interface LiveRetryStatus {
  sessionID: string
  attempt: number
  message: string
  next: number
}

export function useChatSession({
  paneId,
  chatAreaRef,
  currentModel,
  refetchModels,
  sessionId: routeSessionId,
  navigateToSession,
  navigateHome,
}: UseChatSessionOptions) {
  const { statusMap } = useActiveSessionStore()
  const capabilities = usePiCapabilities()

  // Agents
  const agents: ApiAgent[] = []
  const [selectedAgent, setSelectedAgentRaw] = useState<string>(
    () => serverStorage.get(`${STORAGE_KEY_SELECTED_AGENT}:${paneId}`) || '',
  )
  const [restoredContent, setRestoredContent] = useState<{ sessionId: string; content: RevertHistoryItem } | null>(null)
  const pendingPiCommandIds = useRef(new Set<string>())

  useEffect(() => {
    const handleCommandUpdate = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<{
        commandId?: string
        sessionId?: string
        status?: string
        error?: { message?: string }
        commandType?: string
        inputText?: string
      }>).detail
      if (!routeSessionId || detail?.sessionId !== routeSessionId) return
      if (!detail.commandId || !pendingPiCommandIds.current.has(detail.commandId)) return
      if (detail.status !== 'completed' && detail.status !== 'failed' && detail.status !== 'cancelled' &&
        detail.status !== 'unknown_after_crash') return
      pendingPiCommandIds.current.delete(detail.commandId)
      if (detail.status === 'completed') return
      const type = detail.commandType
      const text = detail.inputText
      if ((type === 'session.prompt' || type === 'session.steer' || type === 'session.followUp') && text) {
        setRestoredContent({
          sessionId: routeSessionId,
          content: { messageId: detail.commandId ?? `failed-${Date.now()}`, text, attachments: [] },
        })
      }
      if (detail.error?.message) handleError('execute command', new Error(detail.error.message))
    }
    window.addEventListener('piui:command-updated', handleCommandUpdate)
    return () => window.removeEventListener('piui:command-updated', handleCommandUpdate)
  }, [routeSessionId])

  const setSelectedAgent = useCallback(
    (agentName: string) => {
      setSelectedAgentRaw(agentName)
      serverStorage.set(`${STORAGE_KEY_SELECTED_AGENT}:${paneId}`, agentName)
    },
    [paneId],
  )

  // Hooks
  const { resetPermissions } = usePermissions()
  const { currentDirectory } = useDirectory()
  const { createSession, sessions } = useSessionContext()
  const { sendNotification } = useNotification()

  const routeStatus = routeSessionId ? statusMap[routeSessionId] : undefined
  const routeSessionIdRef = useRef(routeSessionId)

  useEffect(() => {
    routeSessionIdRef.current = routeSessionId
  }, [routeSessionId])

  const handleMissingRouteSession = useCallback(
    (missingSessionId: string) => {
      if (routeSessionIdRef.current !== missingSessionId) return
      clearSessionRuntimeState(missingSessionId)
      navigateHome()
    },
    [navigateHome],
  )

  const {
    items: queuedFollowups,
    sendingId: queuedFollowupSendingId,
    failedId: queuedFollowupFailedId,
  } = useFollowupQueue(routeSessionId)

  const perSessionStateRaw = useSessionState(routeSessionId)
  const perSessionState = perSessionStateRaw ?? EMPTY_SESSION_STATE
  const editorDraft = useSessionEditorDraft(routeSessionId)

  const messages = perSessionState.messages
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const isStreaming = perSessionState.isStreaming
  const sessionDirectory = perSessionState.directory
  const canUndo = perSessionState.canUndo
  const canRedo = perSessionState.canRedo
  const redoSteps = perSessionState.redoSteps
  const revertedContent = perSessionState.revertedContent
  const hasMoreHistory = perSessionState.hasMoreHistory
  const loadState = routeSessionId ? perSessionState.loadState : ('idle' as const)
  const loadError = routeSessionId ? perSessionState.loadError : undefined

  // OpenAPI SessionStatus.retry: { attempt, message, next }
  const retryStatus = useMemo<LiveRetryStatus | null>(() => {
    if (!routeSessionId || routeStatus?.type !== 'retry') return null
    return {
      sessionID: routeSessionId,
      attempt: routeStatus.attempt,
      message: routeStatus.message,
      next: routeStatus.next,
    }
  }, [routeSessionId, routeStatus])

  const isSessionBusy = useMemo(() => Boolean(routeStatus) || isStreaming, [routeStatus, isStreaming])

  const getSessionTitle = useCallback(
    (sessionId?: string) => {
      const session = sessions.find(s => s.id === sessionId)
      if (session?.title) return session.title
      if (sessionId) return `Session ${sessionId.slice(0, 6)}`
      return 'OpenCode'
    },
    [sessions],
  )

  const buildNotificationTitle = useCallback(
    (sessionId: string | undefined, label: string) => {
      const base = getSessionTitle(sessionId)
      return `${base} - ${label}`
    },
    [getSessionTitle],
  )

  // Session Manager
  const { loadSession, loadMoreHistory, handleUndo, handleRedo, handleRedoAll, clearRevert } = useSessionManager({
    sessionId: routeSessionId,
    directory: currentDirectory,
    onSessionMissing: handleMissingRouteSession,
  })

  // Permission handling
  const {
    pendingPermissionRequests,
    pendingQuestionRequests,
    setPendingPermissionRequests,
    setPendingQuestionRequests,
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    resetPendingRequests,
    isReplying,
  } = usePermissionHandler()

  // Prevent infinite retry loops when auto-approve API calls fail
  // but the server may have already processed the request (lost response).
  const autoRetriedIdsRef = useRef(new Set<string>())

  // Message animations
  const { registerMessage, registerInputBox, animateUndo, animateRedo } = useMessageAnimation()

  // Effective directory (used in multiple places)
  const effectiveDirectory = sessionDirectory || currentDirectory

  const fullAutoMode = useSyncExternalStore(
    cb => autoApproveStore.onFullAutoChange(cb),
    () => autoApproveStore.getPaneFullAutoMode(paneId),
  )
  const approvePendingOnFullAuto = useSyncExternalStore(
    autoApproveStore.subscribe,
    () => autoApproveStore.approvePendingOnFullAuto,
  )

  const replyPermissionOnceAutomatically = useCallback(
    (request: ApiPermissionRequest) => {
      if (!autoApproveStore.claimAutoReply(request.id)) return

      void handlePermissionReply(request.id, 'once', effectiveDirectory, request.sessionID).then(success => {
        if (!success) {
          autoApproveStore.releaseAutoReply(request.id)
          // Retry once on failure. handlePermissionReply already retries 3× via withRetry,
          // but the server may have processed the request and the response was lost.
          // Force effect re-run by creating a new array reference.
          if (!autoRetriedIdsRef.current.has(request.id)) {
            autoRetriedIdsRef.current.add(request.id)
            setPendingPermissionRequests(prev => [...prev])
          }
        }
      })
    },
    [effectiveDirectory, handlePermissionReply, setPendingPermissionRequests],
  )

  // Clear retry tracking on each auto-approve batch
  useEffect(() => {
    autoRetriedIdsRef.current.clear()
  }, [approvePendingOnFullAuto, fullAutoMode])

  useEffect(() => {
    if (!approvePendingOnFullAuto || fullAutoMode === 'off' || pendingPermissionRequests.length === 0) return

    for (const request of pendingPermissionRequests) {
      replyPermissionOnceAutomatically(request)
    }
  }, [approvePendingOnFullAuto, fullAutoMode, pendingPermissionRequests, replyPermissionOnceAutomatically])

  // ============================================
  // SSE 事件回调（permission / question / scroll / idle / error / reconnect）
  // 每个 pane 都注册自己的 consumer，由 App 顶层统一建立 SSE 连接
  // ============================================
  const sseCallbacks = useMemo(
    () => ({
      onPermissionAsked: (request: import('../api').ApiPermissionRequest) => {
        // Full Auto 会话级：当前 session 的 handler 天然只处理当前 session 的请求
        const effectiveFullAutoMode = autoApproveStore.getPaneFullAutoMode(paneId)
        if (effectiveFullAutoMode === 'session') {
          replyPermissionOnceAutomatically(request)
          return
        }

        // 自动批准检查（实验性功能）
        if (
          autoApproveStore.enabled &&
          autoApproveStore.shouldAutoApprove(request.sessionID, request.permission, request.patterns ?? [])
        ) {
          // 匹配规则，自动用 once 批准，不弹框
          replyPermissionOnceAutomatically(request)
          return
        }

        setPendingPermissionRequests(prev => {
          if (prev.some(r => r.id === request.id)) return prev
          return [...prev, request]
        })

        // 页面不在前台时通知用户有权限请求等待批准
        const permDesc = request.patterns?.length ? `${request.permission}: ${request.patterns[0]}` : request.permission
        const title = buildNotificationTitle(request.sessionID, 'Permission Required')
        if (notificationEventSettingsStore.isSystemEnabled('permission')) {
          sendNotification(title, permDesc, {
            sessionId: request.sessionID,
            directory: effectiveDirectory,
          })
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onPermissionReplied: (data: { sessionID: string; requestID: string }) => {
        setPendingPermissionRequests(prev =>
          prev.some(r => r.id === data.requestID) ? prev.filter(r => r.id !== data.requestID) : prev,
        )
      },
      onQuestionAsked: (request: import('../api').ApiQuestionRequest) => {
        setPendingQuestionRequests(prev => {
          if (prev.some(r => r.id === request.id)) return prev
          return [...prev, request]
        })

        // 页面不在前台时通知用户有问题等待回答
        const questionDesc = request.questions?.[0]?.header || 'AI is waiting for your input'
        const title = buildNotificationTitle(request.sessionID, 'Question')
        if (notificationEventSettingsStore.isSystemEnabled('question')) {
          sendNotification(title, questionDesc, {
            sessionId: request.sessionID,
            directory: effectiveDirectory,
          })
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onQuestionReplied: (data: { sessionID: string; requestID: string }) => {
        setPendingQuestionRequests(prev => prev.filter(r => r.id !== data.requestID))
      },
      onQuestionRejected: (data: { sessionID: string; requestID: string }) => {
        setPendingQuestionRequests(prev => prev.filter(r => r.id !== data.requestID))
      },
      onScrollRequest: () => {
        chatAreaRef.current?.scrollToBottomIfAtBottom()
      },
      onSessionIdle: (sessionID: string) => {
        // 页面不在前台时发送浏览器通知
        const title = buildNotificationTitle(sessionID, 'Session completed')
        if (notificationEventSettingsStore.isSystemEnabled('completed')) {
          sendNotification(title, 'Session completed', {
            sessionId: sessionID,
            directory: effectiveDirectory,
          })
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onSessionError: (sessionID: string) => {
        // 页面不在前台时通知用户 session 出错
        const title = buildNotificationTitle(sessionID, 'Session error')
        if (notificationEventSettingsStore.isSystemEnabled('error')) {
          sendNotification(title, 'Session error', {
            sessionId: sessionID,
            directory: effectiveDirectory,
          })
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onReconnected: (_reason: 'network' | 'server-switch') => {
        messageStore.markAllSessionsStale()

        // SSE 重连后重新加载当前会话，补齐断连期间可能丢失的消息
        if (routeSessionId) {
          // 使用 force 模式，确保覆盖本地可能不完整的数据
          loadSession(routeSessionId, { force: true })
        }
        refetchModels().catch(() => {})
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and stable functions
    [
      paneId,
      effectiveDirectory,
      routeSessionId,
      replyPermissionOnceAutomatically,
      setPendingPermissionRequests,
      setPendingQuestionRequests,
      buildNotificationTitle,
      sendNotification,
      loadSession,
      refetchModels,
    ],
  )

  // 保存 callbacks ref 供 consumer 注册使用（避免频繁重新注册）
  const sseCallbacksRef = useRef(sseCallbacks)
  useEffect(() => {
    sseCallbacksRef.current = sseCallbacks
  }, [sseCallbacks])

  // 注册 pane 级 consumer，SSE 事件按 sessionId 分发到此
  useEffect(() => {
    const unregister = registerSessionConsumer(paneId, routeSessionId, {
      onPermissionAsked: req => sseCallbacksRef.current.onPermissionAsked(req),
      onPermissionReplied: data => sseCallbacksRef.current.onPermissionReplied(data),
      onQuestionAsked: req => sseCallbacksRef.current.onQuestionAsked(req),
      onQuestionReplied: data => sseCallbacksRef.current.onQuestionReplied(data),
      onQuestionRejected: data => sseCallbacksRef.current.onQuestionRejected(data),
      onScrollRequest: () => sseCallbacksRef.current.onScrollRequest(),
      onSessionIdle: sid => sseCallbacksRef.current.onSessionIdle(sid),
      onSessionError: sid => sseCallbacksRef.current.onSessionError(sid),
      onReconnected: reason => sseCallbacksRef.current.onReconnected(reason),
    })

    return unregister
  }, [paneId, routeSessionId])

  // sessionId 变化时更新 consumer 关注的 session（无需重新注册）
  useEffect(() => {
    updateConsumerSessionId(paneId, routeSessionId)
  }, [paneId, routeSessionId])

  const handleVisibleMessageIdsChange = useCallback((_ids: string[]) => {
    // No-op: parts are always in memory now
  }, [])

  // Preload @ root directory and / commands for current session directory
  useEffect(() => {
    if (!routeSessionId || !effectiveDirectory) return

    prefetchCommands(effectiveDirectory).catch(() => {})
  }, [routeSessionId, effectiveDirectory])

  // agents 列表加载后，校验当前选中的 agent 是否存在于列表中
  useEffect(() => {
    if (agents.length === 0) return
    const primaryAgents = agents.filter(a => a.mode !== 'subagent' && !a.hidden)
    if (primaryAgents.length === 0) return

    // 当前选中的 agent 在列表中存在就不动
    if (selectedAgent && primaryAgents.some(a => a.name === selectedAgent)) return

    // 否则选第一个 primary agent
    const frameId = requestAnimationFrame(() => {
      setSelectedAgent(primaryAgents[0].name)
    })

    return () => cancelAnimationFrame(frameId)
  }, [agents, selectedAgent, setSelectedAgent])

  // Pi v1 has no child-session or permission polling endpoint yet
  useEffect(() => {
    if (!routeSessionId) {
      resetPendingRequests()
      return
    }
    setPendingPermissionRequests([])
    setPendingQuestionRequests([])
  }, [routeSessionId, resetPendingRequests, setPendingPermissionRequests, setPendingQuestionRequests])

  const sendMessageNow = useCallback(
    async (input: {
      sessionId?: string | null
      content: string
      attachments: Attachment[]
      directory: string
      model?: { providerID: string; modelID: string }
      options?: { agent?: string; variant?: string; delivery?: 'steer' | 'followUp' }
      allowCreateSession?: boolean
    }) => {
      let sessionId = input.sessionId ?? routeSessionId

      if (sessionId && input.allowCreateSession) {
        const state = messageStore.getSessionState(sessionId)
        if (state?.loadState === 'error' && state.messages.length === 0) {
          clearSessionRuntimeState(sessionId)
          sessionId = null
        }
      }

      let rollbackSnapshot = sessionId ? messageStore.createSendRollbackSnapshot(sessionId) : null

      try {
        if (!sessionId) {
          if (!input.allowCreateSession) return false
          const newSession = await createSession()
          sessionId = newSession.id
          navigateToSession(sessionId, newSession.directory)
        }

        if (input.attachments.length > 0) {
          throw new Error('PiUI attachments are not supported yet')
        }
        const busy = messageStore.getSessionState(sessionId)?.isStreaming === true
        const delivery = busy ? input.options?.delivery : undefined
        if (busy && !delivery) throw new Error('Choose steer or follow-up while the session is running')
        messageStore.setStreaming(sessionId, true)
        let commandId: string | undefined
        try {
          const { ensurePiEventSocket } = await import('../pi/eventSocket')
          ensurePiEventSocket()
          commandId = globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`
          pendingPiCommandIds.current.add(commandId)
          await promptSession(sessionId, input.content, {
            stream: true,
            model: input.model,
            deliverAs: delivery,
            commandId,
          })
          return true
        } catch (error) {
          if (commandId) pendingPiCommandIds.current.delete(commandId)
          if (!busy) messageStore.setStreaming(sessionId, false)
          throw error
        }
      } catch (error) {
        handleError('send message', error)
        if (sessionId) {
          if (rollbackSnapshot) {
            messageStore.restoreSendRollback(sessionId, rollbackSnapshot)
            rollbackSnapshot = null
          } else {
            messageStore.setStreaming(sessionId, false)
          }
        }

        return false
      }
    },
    [routeSessionId, navigateToSession, createSession],
  )

  // Send message handler
  const handleSend = useCallback(
    async (
      content: string,
      attachments: Attachment[],
      options?: { agent?: string; variant?: string; delivery?: 'steer' | 'followUp' },
    ) => {
      // 如果队列头有失败项，用户重新发送时先清掉失败项（内容已恢复到输入框）
      if (routeSessionId && queuedFollowupFailedId) {
        followupQueueStore.remove(routeSessionId, queuedFollowupFailedId)
      }

      return sendMessageNow({
        sessionId: routeSessionId,
        content,
        attachments,
        model: currentModel ? { providerID: currentModel.providerId, modelID: currentModel.id } : undefined,
        options,
        directory: effectiveDirectory || '',
        allowCreateSession: true,
      })
    },
    [
      currentModel,
      routeSessionId,
      queuedFollowupFailedId,
      effectiveDirectory,
      sendMessageNow,
    ],
  )

  const sendQueuedFollowup = useCallback(
    async (draftId: string, sessionId: string) => {
      const draft = followupQueueStore.getItem(sessionId, draftId)
      if (!draft) return false
      if (!followupQueueStore.startSending(draft.sessionId, draft.id)) return false

      // 发送前先移除占位消息，让 sendMessageNow 走和正常发送完全一样的路径
      messageStore.removeMessage(draft.sessionId, draft.id)

      const ok = await sendMessageNow({
        sessionId: draft.sessionId,
        content: draft.text,
        attachments: draft.attachments,
        model: {
          providerID: draft.model.providerID,
          modelID: draft.model.modelID,
        },
        options: {
          agent: draft.agent,
          variant: draft.variant,
        },
        directory: draft.directory,
      })

      followupQueueStore.finishSending(draft.sessionId, draft.id)

      if (ok) {
        followupQueueStore.remove(draft.sessionId, draft.id)
      } else {
        // 标记失败，阻塞后续队列项
        followupQueueStore.markFailed(draft.sessionId, draft.id)
        // 移除剩余排队消息的本地占位，恢复队头到输入框
        const remaining = followupQueueStore.getItems(draft.sessionId)
        for (const item of remaining) {
          messageStore.removeMessage(draft.sessionId, item.id)
        }
        setRestoredContent({
          sessionId: draft.sessionId,
          content: {
            messageId: draft.id,
            text: draft.text,
            attachments: draft.attachments,
            model: draft.model,
            variant: draft.variant ?? draft.model.variant,
            agent: draft.agent,
          },
        })
      }

      return ok
    },
    [sendMessageNow],
  )

  useEffect(() => {
    if (!routeSessionId) return

    const nextQueued = queuedFollowups[0]
    if (!nextQueued) return
    if (queuedFollowupSendingId) return
    if (queuedFollowupFailedId) return
    if (isSessionBusy) return

    void sendQueuedFollowup(nextQueued.id, routeSessionId)
  }, [
    routeSessionId,
    queuedFollowups,
    queuedFollowupSendingId,
    queuedFollowupFailedId,
    isSessionBusy,
    sendQueuedFollowup,
  ])

  // New chat handler
  const handleNewChat = useCallback(() => {
    if (routeSessionId) {
      followupQueueStore.clearSession(routeSessionId)
      if (!hasOtherConsumerForSession(routeSessionId, paneId)) {
        messageStore.clearSession(routeSessionId)
      }
    }
    resetPermissions()
    resetPendingRequests()
  }, [routeSessionId, paneId, resetPermissions, resetPendingRequests])

  const handleForkMessage = useCallback(
    async (message: UIMessage, forkMessageId?: string) => {
      const targetMessageId = forkMessageId || message.info.id
      if (isPiSession(message.info.sessionID)) {
        const targetMessage = messagesRef.current.find(item => item.info.id === targetMessageId)
        const targetEntryId = targetMessage?.info.entryId ??
          (targetMessageId === message.info.id ? message.info.entryId : undefined)
        if (!capabilities.fork || !targetEntryId) return
        try {
          const position = message.info.role === 'user' ? 'before' : 'at'
          const result = await forkPiSession(message.info.sessionID, targetEntryId, position)
          applySnapshotToUi(result.sourceSnapshot, { activate: false })
          applySnapshotToUi(result.targetSnapshot)
          if (result.replacement.cancelled) return

          if (message.info.role === 'user' && isUserMessage(message.info)) {
            const content = extractUserMessageContent(message)
            setRestoredContent({
              sessionId: result.replacement.targetSessionId,
              content: {
                messageId: message.info.id,
                text: result.replacement.selectedText ?? content.text,
                attachments: content.attachments,
                model: message.info.model,
                variant: message.info.model.variant,
                agent: message.info.agent,
              },
            })
          } else {
            setRestoredContent(null)
          }
          window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
          navigateToSession(result.replacement.targetSessionId, result.replacement.targetCwd ?? effectiveDirectory)
        } catch (error) {
          handleError('fork session', error)
        }
        return
      }

      try {
        if (message.info.role === 'assistant') {
          const assistantInfo = message.info as AssistantMessageInfo
          // 后端 fork 语义：messageID 指定的消息**不包含**在新 session 里。
          // 要保留这条 assistant 回复，需要传它之后的下一条用户消息 ID；
          // 如果它已经是最末尾，不传 messageID，fork 整个 session。
          const currentMessages = messagesRef.current
          const idx = currentMessages.findIndex(m => m.info.id === targetMessageId)
          let forkAtMessageId: string | undefined
          if (idx >= 0) {
            for (let i = idx + 1; i < currentMessages.length; i++) {
              if (currentMessages[i].info.role === 'user') {
                forkAtMessageId = currentMessages[i].info.id
                break
              }
            }
          }
          const forkedSession = await forkSession(assistantInfo.sessionID, forkAtMessageId, effectiveDirectory)
          setRestoredContent(null)
          navigateToSession(forkedSession.id, forkedSession.directory)
          return
        }

        if (message.info.role !== 'user') return

        if (!isUserMessage(message.info)) return

        const userInfo = message.info
        const content = extractUserMessageContent(message)
        const forkedSession = await forkSession(userInfo.sessionID, targetMessageId, effectiveDirectory)

        setRestoredContent({
          sessionId: forkedSession.id,
          content: {
            messageId: userInfo.id,
            text: content.text,
            attachments: content.attachments,
            model: userInfo.model,
            variant: userInfo.model.variant,
            agent: userInfo.agent,
          },
        })

        navigateToSession(forkedSession.id, forkedSession.directory)
      } catch (error) {
        handleError('fork session', error)
      }
    },
    [capabilities.fork, effectiveDirectory, navigateToSession],
  )

  // Abort handler
  const handleAbort = useCallback(async () => {
    if (!routeSessionId) return
    const queuedBeforeAbort = sessionProjectionStore.getSnapshot(routeSessionId)?.runtime.queue
    try {
      const { abortSessionCommand } = await import('../pi/sessionApi')
      const result = await abortSessionCommand(routeSessionId)
      applySnapshotToUi(result.snapshot)
      const queuedText = [...result.cleared.steering, ...result.cleared.followUp].join('\n\n')
      if (queuedText) {
        setRestoredContent({
          sessionId: routeSessionId,
          content: { messageId: `abort-${Date.now()}`, text: queuedText, attachments: [] },
        })
      }
      messageStore.setStreaming(routeSessionId, false)
      messageStore.handleSessionIdle(routeSessionId)
    } catch (error) {
      const queuedText = queuedBeforeAbort
        ? [...queuedBeforeAbort.steering, ...queuedBeforeAbort.followUp].join('\n\n')
        : ''
      if (queuedText) {
        setRestoredContent({
          sessionId: routeSessionId,
          content: { messageId: `abort-failed-${Date.now()}`, text: queuedText, attachments: [] },
        })
      }
      handleError('abort session', error)
    }
  }, [routeSessionId])

  // Command handler (slash commands)
  const handleCommand = useCallback(
    async (commandStr: string) => {
      // 解析命令："/help arg1 arg2" => command="help", args="arg1 arg2"
      const trimmed = commandStr.trim()
      const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
      const spaceIndex = withoutSlash.indexOf(' ')
      const command = spaceIndex > 0 ? withoutSlash.slice(0, spaceIndex) : withoutSlash
      const args = spaceIndex > 0 ? withoutSlash.slice(spaceIndex + 1) : ''

      if (!command) return false

      if (command === 'new') {
        navigateHome()
        handleNewChat()
        return true
      }

      let sessionId = routeSessionId

      try {
        if (sessionId) {
          const state = messageStore.getSessionState(sessionId)
          if (state?.loadState === 'error' && state.messages.length === 0) {
            clearSessionRuntimeState(sessionId)
            sessionId = null
          }
        }

        // Create session if needed (like handleSend does)
        if (!sessionId) {
          const newSession = await createSession()
          sessionId = newSession.id
          navigateToSession(sessionId, newSession.directory)
        }

        if (command === 'compact') {
          void import('../pi/sessionApi')
            .then(({ compactSession }) => args
              ? compactSession(sessionId!, args)
              : compactSession(sessionId!))
            .catch(err => handleError('execute command', err))
          return true
        }

        void sendMessageNow({
          sessionId,
          content: `/${command}${args ? ` ${args}` : ''}`,
          attachments: [],
          model: currentModel ? { providerID: currentModel.providerId, modelID: currentModel.id } : undefined,
          directory: effectiveDirectory || '',
          allowCreateSession: false,
        }).catch(err => {
          handleError('execute command', err)
        })

        return true
      } catch (err) {
        handleError('execute command', err)
        return false
      }
    },
    [routeSessionId, effectiveDirectory, createSession, navigateToSession, currentModel, navigateHome, handleNewChat],
  )

  // Undo with animation
  const handleUndoWithAnimation = useCallback(
    async (userMessageId: string) => {
      const currentMessages = messagesRef.current
      const messageIndex = currentMessages.findIndex(m => m.info.id === userMessageId)
      if (messageIndex === -1) return

      const messageIdsToRemove = currentMessages.slice(messageIndex).map(m => m.info.id)

      await animateUndo(messageIdsToRemove)
      await handleUndo(userMessageId)
    },
    [animateUndo, handleUndo],
  )

  // Redo with animation
  const handleRedoWithAnimation = useCallback(async () => {
    await animateRedo()
    await handleRedo()
  }, [animateRedo, handleRedo])

  // Session selection
  const handleSelectSession = useCallback(
    (session: UiSession) => {
      navigateToSession(session.id, session.directory)
    },
    [navigateToSession],
  )

  // New session
  const handleNewSession = useCallback(() => {
    navigateHome()
    handleNewChat()
  }, [navigateHome, handleNewChat])

  // Archive current session
  const handleArchiveSession = useCallback(async () => {
    if (!routeSessionId || !capabilities.sessionArchive) return
    try {
      await updateSession(routeSessionId, { archivedAt: Date.now() }, effectiveDirectory)
      navigateHome()
      handleNewChat()
    } catch (error) {
      handleError('archive session', error)
    }
  }, [routeSessionId, capabilities.sessionArchive, effectiveDirectory, navigateHome, handleNewChat])

  // Navigate to previous session
  const handlePreviousSession = useCallback(() => {
    if (!sessions.length) return
    const currentIndex = sessions.findIndex(s => s.id === routeSessionId)
    if (currentIndex > 0) {
      const target = sessions[currentIndex - 1]
      navigateToSession(target.id, target.directory)
    } else if (currentIndex === -1 && sessions.length > 0) {
      // Not in any session, go to first
      navigateToSession(sessions[0].id, sessions[0].directory)
    }
  }, [sessions, routeSessionId, navigateToSession])

  // Navigate to next session
  const handleNextSession = useCallback(() => {
    if (!sessions.length) return
    const currentIndex = sessions.findIndex(s => s.id === routeSessionId)
    if (currentIndex >= 0 && currentIndex < sessions.length - 1) {
      const target = sessions[currentIndex + 1]
      navigateToSession(target.id, target.directory)
    }
  }, [sessions, routeSessionId, navigateToSession])

  // Toggle agent (cycle through primary agents only, matching toolbar display)
  const handleToggleAgent = useCallback(() => {
    const primaryAgents = agents.filter(a => a.mode !== 'subagent' && !a.hidden)
    if (primaryAgents.length <= 1) return
    const currentIndex = primaryAgents.findIndex(a => a.name === selectedAgent)
    const nextIndex = (currentIndex + 1) % primaryAgents.length
    setSelectedAgent(primaryAgents[nextIndex].name)
  }, [agents, selectedAgent, setSelectedAgent])

  // 从消息中恢复 agent 选择（用于切换 session 时）
  const restoreAgentFromMessage = useCallback(
    (agentName: string | null | undefined) => {
      if (!agentName) return
      // 只有当 agent 存在于列表中时才恢复
      const exists = agents.some(a => a.name === agentName && a.mode !== 'subagent' && !a.hidden)
      if (exists) {
        setSelectedAgent(agentName)
      }
    },
    [agents, setSelectedAgent],
  )

  // Copy last AI response to clipboard
  const handleCopyLastResponse = useCallback(async () => {
    const lastAssistant = [...messages].reverse().find(m => m.info.role === 'assistant')
    if (!lastAssistant) return

    const text = getMessageText(lastAssistant)
    if (text) {
      try {
        await copyTextToClipboard(text)
      } catch (err) {
        clipboardErrorHandler('copy last response', err)
      }
    }
  }, [messages])

  const clearRestoredContent = useCallback(() => {
    setRestoredContent(null)
    if (routeSessionId) clearSessionEditorDraft(routeSessionId)
    clearRevert()
  }, [clearRevert, routeSessionId])

  const activeRestoredContent = useMemo(() => {
    if (restoredContent?.sessionId === routeSessionId) return restoredContent.content
    if (!editorDraft) return null
    return {
      messageId: `tree-${editorDraft.revision}`,
      text: editorDraft.text,
      attachments: [],
    }
  }, [editorDraft, restoredContent, routeSessionId])

  return {
    // State
    messages,
    // UI 活跃态：对齐官方 webui 的 session_working（session.status busy/retry）
    // 不能只信 messageStore.isStreaming——多步 agent 间隙消息可能已 completed，但 session 仍 busy
    isStreaming: isSessionBusy,
    /** 消息级流式（不含 session.status）；一般 UI 用 isStreaming 即可 */
    messageIsStreaming: isStreaming,
    sessionDirectory,
    canUndo,
    canRedo,
    redoSteps,
    revertedContent,
    restoredContent: activeRestoredContent,
    loadState,
    loadError,
    hasMoreHistory,
    retryStatus,
    agents,
    selectedAgent,
    setSelectedAgent,
    routeSessionId,
    effectiveDirectory,

    // Permissions
    pendingPermissionRequests,
    pendingQuestionRequests,
    queuedFollowups,
    queuedFollowupSendingId,
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    isReplying,

    // Session management
    loadMoreHistory,
    handleRedoAll,
    clearRevert: clearRestoredContent,

    // Animation
    registerMessage,
    registerInputBox,

    // Handlers
    handleSend,
    handleAbort,
    handleCommand,
    handleUndoWithAnimation,
    handleRedoWithAnimation,
    handleForkMessage,
    handleSelectSession,
    handleNewSession,
    handleVisibleMessageIdsChange,
    handleArchiveSession,
    handlePreviousSession,
    handleNextSession,
    handleToggleAgent,
    handleCopyLastResponse,
    restoreAgentFromMessage,
  }
}
