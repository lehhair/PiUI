import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'
import type { Model, Api } from '@earendil-works/pi-ai'
import { ChatArea, Header, InputBox, type ChatAreaHandle, type InputBoxHandle } from '../chat/index.js'
import type { ModelSelectorHandle } from '../chat/ModelSelector.js'
import { PaneHeader } from '../chat/PaneHeader.js'
import { PaneDropOverlay, resolveDropZone, type DropZone, type PaneDropOverlayHandle } from '../chat/PaneDropOverlay.js'
import { useFolderProjectDrop } from '../chat/useFolderProjectDrop.js'
import { FolderProjectDropOverlay } from '../chat/FolderProjectDropOverlay.js'
import { ChatViewportProvider, useChatViewportMaybe, type ChatViewportValue } from '../chat/chatViewport.js'
import type { Attachment } from '../attachment/index.js'
import { ExtensionUiDialogHost } from '../chat/ExtensionUiDialogHost.js'
import { ProjectTrustPrompt } from './ProjectTrustPrompt'
import { OutlineIndex } from '../../components/OutlineIndex'
import { buildOutlineSourceEntries } from '../../components/outlineIndexModel'
import { selectPiTimelineItemsCached } from '../../pi/selectors/timelineCache.js'
import { piEventStream } from '../../pi/eventStream.js'
import { bashPendingStore } from '../../pi/bashPendingStore'
import {
  abortPiOperation,
  abortPiCompaction,
  compactPiSession,
  cyclePiModel,
  cyclePiThinkingLevel,
  executePiBash,
  exportPiSession,
  forkPiSession,
  importPiSession,
  loadMorePiBranchEntries,
  loadPiSessionRegistry,
  logoutPiProvider,
  refreshPiBranch,
  refreshPiSessionState,
  loadPiModels,
  loadPiSessionData,
  navigatePiTree,
  newPiSessionFrom,
  openPiSession,
  reloadPiSessionResources,
  renamePiSession,
  sendPiPrompt,
  sendPiUserMessage,
  setPiProjectTrust,
  setPiScopedModels,
  startPiProviderAuth,
  setPiExtensionEditorState,
  setPiModel,
  setPiThinkingLevel,
} from '../../pi/controllers/index.js'
import { invokePiCommand } from '../../pi/transport/index.js'
import { layoutStore } from '../../store/layoutStore'
import { themeStore } from '../../store/themeStore'
import { useSessionActiveEntry } from '../../store/activeSessionStore'
import type { PiImageInput } from '../../pi/transport/index.js'
import { attachmentToImage } from './attachmentToImage'
import { piBranchStore } from '../../pi/state/index.js'
import { captureRedoCheckpoints, commitRedoPlan, redoPlanStore, type RedoPlan } from '../../pi/redoPlanStore'
import { extensionUiStore } from '../../pi/extensionUiStore'
import { commandFeedbackStore, type CommandFeedbackStatus } from '../../pi/commandFeedbackStore'
import { trackPiSession } from '../../pi/piSessionIndex'
import { resolveWorkspacePath } from '../../pi/workspaces.js'
import { stashForkText, subscribeForkSeed, takeForkText } from '../../pi/pendingForkText'
import { clearSessionEditorDraft, configureSessionEditorDraftSync, setSessionEditorDraft, useSessionEditorDraft } from '../../pi/sessionEditorDraftStore'
import { isSessionBusyError, isSessionNotFoundError, uiErrorHandler } from '../../utils'
import { usePiBranchData, usePiBranchError, usePiModels, usePiSessionRuntimeState } from '../../pi/hooks/index.js'
import { useDirectory } from '../../contexts/useDirectory'
import { useSessionContext } from '../../contexts/useSessionContext'
import { SessionNavigationContext, type SessionNavigationContextValue } from '../../contexts/SessionNavigationContext'
import { paneLayoutStore } from '../../store/paneLayoutStore'
import { notificationStore } from '../../store/notificationStore'
import { useServerStore } from '../../hooks/useServerStore'
import { useManagementEvents } from '../../pi/managementEventStore'
import { getInternalDragSnapshot, subscribeInternalDrag, subscribeInternalDrop } from '../../lib/internalDragCore'
import { copyTextToClipboard } from '../../utils/clipboard'
import {
  getModelVariantPref,
  getPreferredModelKey,
  recordModelUsage,
  saveModelVariantPref,
  setPreferredModelKey,
} from '../../utils/modelUtils'

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
// 这些命令自带界面（选择器/设置/面板），执行后不自动展开扩展面板
const AUTO_EXPAND_EXCLUDED = new Set(['new', 'settings', 'hotkeys', 'changelog', 'model', 'resume', 'tree'])
/** 稳定空数组引用：避免 `?? []` 每次渲染新建数组导致 ChatArea memo 失效 */
const EMPTY_STRING_ARRAY: readonly string[] = []

/** fork 第一条消息的纯前端特判：不开 SDK 会话，直接落在首页预填 */
const HOME_FORK_KEY = 'home'

// ============================================
// Compact viewport shell for split panes (from ocui ChatPane).
// Layout/presentation stay fixed; enableCollapsedInputDock is inherited
// from the app viewport.
// ============================================
const PANE_VIEWPORT: ChatViewportValue = {
  presentation: {
    surfaceVariant: 'compact',
    isCompact: true,
  },
  interaction: {
    mode: 'pointer',
    touchCapable: false,
    sidebarBehavior: 'overlay',
    rightPanelBehavior: 'overlay',
    bottomPanelBehavior: 'overlay',
    outlineInteraction: 'pointer',
    enableCollapsedInputDock: false,
  },
  layout: {
    viewportWidth: 800,
    viewportHeight: 600,
    surfaceWidth: 800,
    surfaceMinWidth: 380,
    sidebar: {
      railWidth: 0,
      requestedWidth: 0,
      openWidth: 0,
      dockedWidth: 0,
      overlayWidth: 0,
      hardMinWidth: 0,
      preferredMinWidth: 0,
      maxWidth: 0,
      resizeMaxWidth: 0,
    },
    rightPanel: {
      requestedWidth: 0,
      dockedWidth: 0,
      hardMinWidth: 0,
      maxWidth: 0,
      resizeMaxWidth: 0,
    },
    bottomPanel: {
      maxHeight: 0,
    },
  },
  actions: {
    setSidebarRequestedWidth: () => {},
  },
}

let splitSessionNavigationToken = 0

function scheduleSplitSessionNavigation(callback: () => void) {
  const token = ++splitSessionNavigationToken
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (token !== splitSessionNavigationToken) return
      splitSessionNavigationToken = 0
      callback()
    })
  })
}

function cancelPendingSplitSessionNavigation() {
  if (splitSessionNavigationToken !== 0) {
    splitSessionNavigationToken += 1
  }
}

interface PiChatPaneProps {
  paneId: string
  sessionId: string | null
  isFocused?: boolean
  paneCount?: number
  displayMode?: 'single' | 'split'
  isPaneFullscreen?: boolean
  /** Home flow: called after the first send creates a session */
  onEnterSession?: (sessionId: string, directory: string) => void
  onNewChat?: () => void
  onOpenSidebar?: () => void
  onOpenSettings?: () => void
  onOpenSettingsTab?: (tab: 'config' | 'keybindings' | 'about') => void
  onToggleRightPanel?: () => void
  onSplitPane?: () => void
  onTogglePaneFullscreen?: () => void
  showSidebarButton?: boolean
  navigatePaneToSession?: (paneId: string, sessionId: string, directory?: string) => void
}


function textFromTimelineItem(item: unknown): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ''
  const blocks = (item as { blocks?: unknown }).blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block): block is { type: 'text'; text: string } => (
      Boolean(block) && typeof block === 'object' && !Array.isArray(block)
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map(block => block.text)
    .join('\n')
}

/**
 * Pi-native chat pane. Shell structure mirrors ocui's ChatPane (single and
 * split modes, compact pane shell, session drag & drop); only the data
 * source is Pi (keyed stores via hooks, event stream per session).
 */
export function PiChatPane({
  paneId,
  sessionId,
  isFocused = false,
  paneCount = 1,
  displayMode = 'single',
  isPaneFullscreen = false,
  onEnterSession,
  onNewChat,
  onOpenSidebar,
  onOpenSettings,
  onOpenSettingsTab,
  onToggleRightPanel,
  onSplitPane,
  onTogglePaneFullscreen,
  showSidebarButton = false,
  navigatePaneToSession,
}: PiChatPaneProps) {
  const { t } = useTranslation(['chat', 'common'])
  const onEnterSessionRef = useRef(onEnterSession)
  const onNewChatRef = useRef(onNewChat)
  const { currentDirectory, addDirectory } = useDirectory()
  const { registerSession } = useSessionContext()
  const { activeServer, activeServerGeneration } = useServerStore()
  const { providerRevision } = useManagementEvents()
  const registerSessionRef = useRef(registerSession)
  const currentDirectoryRef = useRef(currentDirectory)
  useEffect(() => {
    // latest-value refs：事件回调保持稳定依赖的同时总能读到最新值
    onEnterSessionRef.current = onEnterSession
    onNewChatRef.current = onNewChat
    registerSessionRef.current = registerSession
    currentDirectoryRef.current = currentDirectory
  })

  // ============================================
  // Pi data layer: event stream + keyed stores
  // ============================================
  const { models, isLoading: modelsLoading } = usePiModels()
  useEffect(() => {
    void loadPiModels().catch(() => undefined)
  }, [activeServerGeneration, activeServer?.id, activeServer?.url, activeServer?.token, currentDirectory, providerRevision])

  const branch = usePiBranchData(sessionId)
  const branchError = usePiBranchError(sessionId)
  const state = usePiSessionRuntimeState(sessionId)
  // 压缩中：优先用活动状态（worker 推送、已验证可靠），state.isCompacting 兜底
  const sessionEntry = useSessionActiveEntry(sessionId ?? '')
  const compacting = sessionEntry?.status.type === 'compacting' || state?.isCompacting === true
  const sessionUnavailableRef = useRef(false)
  const [isRetryingSession, setIsRetryingSession] = useState(false)
  // 只有服务端明确返回找不到会话时才显示“不存在”；网络、鉴权和服务端
  // 启动中的临时错误不能被误报成已删除。
  const sessionUnavailable = Boolean(sessionId && !branch && branchError && isSessionNotFoundError(branchError))
  const sessionLoadError = Boolean(sessionId && !branch && branchError && !sessionUnavailable)
  const sessionBusy = Boolean(sessionId && !branch && branchError && isSessionBusyError(branchError))
  useEffect(() => {
    sessionUnavailableRef.current = sessionUnavailable || sessionLoadError
  })

  const retrySession = useCallback(async () => {
    if (!sessionId || isRetryingSession) return
    setIsRetryingSession(true)
    try {
      await loadPiSessionData(sessionId)
    } catch {
      // 错误已写入 branch store，由页面状态展示
    } finally {
      setIsRetryingSession(false)
    }
  }, [isRetryingSession, sessionId])

  useEffect(() => {
    // 会话已不可用：不订阅事件流，免得每次重连都 resync 打 404
    if (!sessionId || sessionUnavailable || sessionLoadError) return
    piEventStream.connect(sessionId)
    if (!piBranchStore.getData(sessionId)) {
      void loadPiSessionData(sessionId).catch(() => undefined)
    }
    return () => piEventStream.disconnect(sessionId)
  }, [activeServerGeneration, activeServer?.id, activeServer?.token, activeServer?.url, sessionId, sessionLoadError, sessionUnavailable])

  // Fork 带来的待编辑文本：进入目标会话时取走，灌进输入框。
  // fork 的 replacement 事件比命令结果先到时，导航会先于 stash 发生，
  // 所以既要在 sessionId 变化时尝试，也要订阅 stash 通知补漏；
  // 只有真正拿到种子才标记已应用，拿不到就等通知
  const [forkSeedText, setForkSeedText] = useState<string | undefined>(undefined)
  const forkSeedAppliedForRef = useRef<string | null>(null)
  const forkSeedHomeAppliedRef = useRef(false)
  const lastEditorTextRef = useRef<string | undefined>(undefined)
  // fork stash 是外部 store：取到一次性种子后同步进本地 state（订阅外部系统同步，
  // 一次性消费语义无法用“渲染期间调整 state”表达，这里保留 effect 同步）
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!sessionId) {
      // fork 第一条消息的纯前端特判会落在 home：一次性取走 home 种子
      if (!forkSeedHomeAppliedRef.current) {
        const seed = takeForkText(HOME_FORK_KEY)
        if (seed) {
          forkSeedHomeAppliedRef.current = true
          setForkSeedText(seed)
        }
      }
      return
    }
    const applySeed = (sid: string) => {
      if (forkSeedAppliedForRef.current === sid) return
      const seed = takeForkText(sid)
      if (!seed) return
      forkSeedAppliedForRef.current = sid
      setForkSeedText(seed)
      // 让扩展编辑器状态和种子一致：worker 端新会话的 editorText 是空，
      // 同步 effect 会把种子抹掉；同时推到 worker，刷新后也能恢复
      extensionUiStore.editorCommand(sid, { kind: 'set', text: seed })
      lastEditorTextRef.current = seed
      void setPiExtensionEditorState(sid, seed).catch(() => undefined)
    }
    applySeed(sessionId)
    return subscribeForkSeed(sid => {
      if (sid === sessionId) applySeed(sid)
    })
  }, [sessionId])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 树导航的编辑器草稿（undo 语义：回到用户消息前，文本进输入框）。
  // 树面板写 draft store，这里消费并同步到 worker 编辑器状态
  const editorDraft = useSessionEditorDraft(sessionId)
  useEffect(() => {
    configureSessionEditorDraftSync((sid, text) => setPiExtensionEditorState(sid, text).catch(() => undefined))
    return () => configureSessionEditorDraftSync(undefined)
  }, [])

  const isStreaming = Boolean(state?.isStreaming)
  const queue = state?.queue as { steering?: string[]; followUp?: string[] } | undefined

  // 稳定队列引用：ChatArea 是 memo 组件，`?? []` 每次渲染新建数组会让它
  // 每次事件都重渲染（实测 4940 事件 → 10356 次渲染）。内容不变时保持
  // 旧引用，只有队列实际变化才触发 ChatArea 重渲染。
  const queuedSteering = useMemo(() => queue?.steering ?? EMPTY_STRING_ARRAY, [queue?.steering])
  const queuedFollowUps = useMemo(() => queue?.followUp ?? EMPTY_STRING_ARRAY, [queue?.followUp])

  // Timeline items from this session's keyed branch; home (no session)
  // shows an empty flow — user types and sends to create one.
  const baseItems = useMemo(() => selectPiTimelineItemsCached(sessionId, branch), [sessionId, branch])
  // 用户发起的 bash 乐观条目（执行中显示 + 流式输出，pi TUI 的
  // BashExecutionComponent 对应物）。订阅 pending 数量变化以便渲染合并。
  const pendingBashCount = useSyncExternalStore(
    bashPendingStore.subscribe,
    () => bashPendingStore.getForSession(sessionId ?? '').length,
  )
  const items = useMemo(() => {
    // pendingBashCount 仅作为 bashPendingStore 变化的订阅信号：store 变化会
    // 触发重渲染，这里显式引用以把它算进依赖，确保乐观条目被重新合并。
    void pendingBashCount
    const pendingItems = sessionId ? bashPendingStore.toItems(baseItems, sessionId) : []
    return pendingItems.length > 0 ? [...baseItems, ...pendingItems] : baseItems
  }, [baseItems, sessionId, pendingBashCount])
  // 扩展 UI 弹窗（权限/问题/选择/输入）：可收起为输入框上方胶囊（FloatingActions）
  const extensionDialogSnapshot = useSyncExternalStore(
    extensionUiStore.subscribe,
    extensionUiStore.getSnapshot,
    extensionUiStore.getSnapshot,
  )
  const pendingDialogs = useMemo(
    () => (sessionId ? extensionDialogSnapshot.sessions[sessionId]?.pending ?? [] : []),
    [sessionId, extensionDialogSnapshot],
  )
  const dialogRequest = useMemo(
    () => [...pendingDialogs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null,
    [pendingDialogs],
  )
  const [dialogCollapsed, setDialogCollapsed] = useState(false)
  // 真实条目落盘后清理已被吸收的乐观条目（toItems 已过滤，这里防泄漏）
  useEffect(() => {
    if (sessionId) bashPendingStore.removeConsumed(baseItems, sessionId)
  }, [baseItems, sessionId])
  // handleFork 用 items 找第一条 user 消息做 home 特判：用 ref 持有最新值，
  // 让回调保持 [sessionId] 稳定 —— items 每次流式事件都是新数组，若进依赖，
  // handleFork 每 token 重建 → VirtualRow memo 的 onFork 比较失配 → 全行重渲染。
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  })

  // Current model from runtime state (native SDK shape); on home (no
  // session) fall back to the composer's persisted preferred model.
  const currentModel = state?.model as { provider?: string; id?: string } | null | undefined
  const [homeModelKey, setHomeModelKey] = useState<string | null>(() => getPreferredModelKey())
  const [pendingModelKey, setPendingModelKey] = useState<string | null>(null)
  const selectedModelKey =
    pendingModelKey ?? (currentModel?.provider && currentModel?.id ? `${currentModel.provider}:${currentModel.id}` : homeModelKey)

  // Thinking level: variants filtered by the current model's support map,
  // current value from runtime state — the native home for this control.
  const currentModelObj = useMemo(
    () => models.find(m => `${m.provider}:${m.id}` === pendingModelKey)
      ?? models.find(m => m.provider === currentModel?.provider && m.id === currentModel?.id)
      ?? (homeModelKey ? models.find(m => `${m.provider}:${m.id}` === homeModelKey) : undefined),
    [models, pendingModelKey, currentModel?.provider, currentModel?.id, homeModelKey],
  )
  const thinkingLevels = useMemo(() => {
    if (!currentModelObj?.reasoning) return ['off']
    const map = currentModelObj.thinkingLevelMap as Record<string, string | null> | undefined
    return PI_THINKING_LEVELS.filter(level => !map || map[level] !== null)
  }, [currentModelObj])
  // On home there is no runtime state; the selector shows the persisted
  // variant preference for the home model, applied once the session exists.
  const [homeVariant, setHomeVariant] = useState<string | undefined>(() =>
    homeModelKey ? getModelVariantPref(homeModelKey) : undefined,
  )
  const [pendingThinkingLevel, setPendingThinkingLevel] = useState<string | undefined>(undefined)
  // home 模型切换时重读持久化 variant 偏好（渲染期间调整 state）
  const [homeVariantForModel, setHomeVariantForModel] = useState(homeModelKey)
  if (homeModelKey !== homeVariantForModel) {
    setHomeVariantForModel(homeModelKey)
    if (!sessionId) setHomeVariant(homeModelKey ? getModelVariantPref(homeModelKey) : undefined)
  }
  // sessionId 变化时重置 pending 状态（渲染期间调整 state，避免 effect 级联渲染）
  const [resetSessionId, setResetSessionId] = useState(sessionId)
  if (sessionId !== resetSessionId) {
    setResetSessionId(sessionId)
    setPendingModelKey(null)
    setPendingThinkingLevel(undefined)
  }
  const thinkingLevel =
    pendingThinkingLevel ?? (typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : undefined) ?? homeVariant

  const handleVariantChange = useCallback(
    (variant: string | undefined) => {
      if (!variant) return
      if (!sessionId) {
        setHomeVariant(variant)
        if (homeModelKey) saveModelVariantPref(homeModelKey, variant)
        return
      }
      setPendingThinkingLevel(variant)
      void setPiThinkingLevel(sessionId, variant)
        .then(() => refreshPiSessionState(sessionId))
        .then(() => setPendingThinkingLevel(current => current === variant ? undefined : current))
        .catch(error => {
          setPendingThinkingLevel(current => current === variant ? undefined : current)
          uiErrorHandler('set thinking level', error)
        })
    },
    [sessionId, homeModelKey],
  )

  const handleModelChange = useCallback(
    (_modelKey: string, model: Model<Api>) => {
      recordModelUsage(model)
      const key = `${model.provider}:${model.id}`
      setHomeModelKey(key)
      setPreferredModelKey(key)
      if (!sessionId) return
      setPendingModelKey(key)
      setPendingThinkingLevel(undefined)
      void setPiModel(sessionId, model.provider, model.id)
        .then(() => refreshPiSessionState(sessionId))
        .then(() => setPendingModelKey(current => current === key ? null : current))
        .catch(error => {
          setPendingModelKey(current => current === key ? null : current)
          uiErrorHandler('set model', error)
        })
    },
    [sessionId],
  )

  // Fork at a user message (pi TUI parity: branch BEFORE the message and
  // carry its text into the new session's composer for edit-and-resend).
  // forkMessageId is the merged tail entry id from ChatArea's visibility
  // model. Forking the FIRST user message is a pure-frontend shortcut:
  // there is no history to branch, so we just go home with the text
  // pre-filled instead of leaving an empty in-memory session behind.
  const handleFork = useCallback(
    async (entryId: string, forkMessageId?: string) => {
      if (!sessionId) return
      const targetId = forkMessageId ?? entryId
      const firstUser = itemsRef.current.find(item => item.kind === 'user_message')
      if (firstUser && firstUser.entryId === targetId) {
        const text = firstUser.blocks
          .filter((block): block is Extract<typeof block, { type: 'text' }> => block?.type === 'text')
          .map(block => block.text)
          .join('\n')
        stashForkText(HOME_FORK_KEY, text)
        onNewChatRef.current?.()
        return
      }
      try {
        const result = await forkPiSession(sessionId, targetId, 'before')
        if (result.cancelled || !result.targetSessionId) return
        if (typeof result.selectedText === 'string' && result.selectedText.trim()) {
          stashForkText(result.targetSessionId, result.selectedText)
        }
        const directory = result.targetCwd ?? currentDirectoryRef.current
        if (directory) {
          onEnterSessionRef.current?.(result.targetSessionId, directory)
        }
      } catch (error) {
        console.error('Failed to fork session:', error)
      }
    },
    [sessionId],
  )

  // 加载更早历史：稳定引用（ChatArea memo），避免每次渲染新建箭头函数
  const handleLoadMore = useCallback(() => {
    if (sessionId) void loadMorePiBranchEntries(sessionId)
  }, [sessionId])

  // ============================================
  // Undo / Redo (pi TUI parity: tree navigation IS the undo).
  // Undo at a user message = navigateTree to it (branch is cut right
  // before that message, its text goes back to the editor). The cut
  // entries stay in the tree as children of the undo point — that is
  // what makes redo possible.
  //
  // Rigor notes:
  // - The undo point can have MULTIPLE child branches (earlier forks,
  //   or a new send after the undo). Redo must follow the branch the
  //   cut entries actually came from, so we capture their entry ids at
  //   undo time instead of guessing a child at redo time.
  // - Single redo restores ONE user turn at a time (navigate to that
  //   turn's tail entry on the original branch); Redo All jumps to the
  //   original branch tip. pi has no redo command — restoring the
  //   branch via navigateTree is the symmetric operation.
  // - canRedo tracks "the leaf is still on the undo path". Sending a
  //   new message or navigating elsewhere moves the leaf off it and the
  //   redo pointer lapses; navigating back to the undo point revives it
  //   (the cut branch is still a child there).
  // ============================================
  const head = (state?.head ?? null) as { epoch?: string; leafId?: string } | null
  const headLeafId = head?.leafId ?? null
  // redo 计划走共享 store：会话树面板里的导航也会产生/清掉计划
  const revertState = useSyncExternalStore(
    redoPlanStore.subscribe,
    () => (sessionId ? redoPlanStore.getPlan(sessionId) : null),
    () => null,
  )
  const redoRestoreAttemptedRef = useRef<string | null>(null)

  const updateRevertState = useCallback((plan: RedoPlan | null) => {
    if (sessionId) redoPlanStore.setPlan(sessionId, plan)
  }, [sessionId])

  // Reset the redo pointer whenever the session changes
  useEffect(() => {
    redoRestoreAttemptedRef.current = null
  }, [sessionId])

  // A page refresh drops React state but not the native tree. Validate the
  // persisted redo plan against this session's runtime head once available.
  useEffect(() => {
    if (!sessionId || !state || !state.head || typeof state.head !== 'object' || Array.isArray(state.head)) return
    if (redoRestoreAttemptedRef.current === sessionId) return
    redoRestoreAttemptedRef.current = sessionId
    const plan = redoPlanStore.getPlan(sessionId)
    if (!plan) return
    const positions = new Set<string | null>([
      plan.undoLeafId,
      ...plan.checkpoints.slice(0, plan.restored),
    ])
    if (plan.epoch !== head?.epoch || !positions.has(headLeafId)) redoPlanStore.setPlan(sessionId, null)
  }, [sessionId, state, headLeafId, head?.epoch])

  // Positions the leaf may legitimately sit at while the plan is alive:
  // the undo point plus the already-restored checkpoints.
  const revertPositions = useMemo(() => {
    if (!revertState) return null
    return new Set<string | null>([
      revertState.undoLeafId,
      ...revertState.checkpoints.slice(0, revertState.restored),
    ])
  }, [revertState])

  // Leaf left the undo path (new send / tree navigation) -> the plan lapses
  useEffect(() => {
    if (!revertState || !revertPositions) return
    if (!state || !state.head || typeof state.head !== 'object' || Array.isArray(state.head)) return
    if (revertPositions.has(headLeafId)) return
    updateRevertState(null)
  }, [headLeafId, revertState, revertPositions, state, updateRevertState])

  const handleUndo = useCallback(
    async (entryId: string) => {
      if (!sessionId || isStreaming) return
      // 逐回合的 redo 落点：沿被裁掉的原分支，每个用户回合的尾部条目。
      // 必须在导航前从 branch 捕获
      const checkpoints = captureRedoCheckpoints(sessionId, entryId)
      try {
        const result = await navigatePiTree(sessionId, { entryId })
        if (result.cancelled || result.aborted) return
        if (result.editorText == null) clearSessionEditorDraft(sessionId)
        else setSessionEditorDraft(sessionId, result.editorText)
        await commitRedoPlan(sessionId, checkpoints)
      } catch (error) {
        console.error('Failed to undo message:', error)
      }
    },
    [sessionId, isStreaming],
  )

  const handleRedoStep = useCallback(async () => {
    if (!sessionId || !revertState || isStreaming) return
    const target = revertState.checkpoints[revertState.restored]
    if (!target) return
    try {
      const result = await navigatePiTree(sessionId, { entryId: target })
      if (result.cancelled || result.aborted) return
      clearSessionEditorDraft(sessionId)
      const restored = revertState.restored + 1
      if (restored >= revertState.checkpoints.length) updateRevertState(null)
      else updateRevertState({ ...revertState, restored })
    } catch (error) {
      console.error('Failed to redo message:', error)
    }
  }, [sessionId, revertState, isStreaming, updateRevertState])

  const handleRedoAll = useCallback(async () => {
    if (!sessionId || !revertState || isStreaming) return
    const target = revertState.checkpoints[revertState.checkpoints.length - 1]
    if (!target) return
    try {
      const result = await navigatePiTree(sessionId, { entryId: target })
      if (result.cancelled || result.aborted) return
      clearSessionEditorDraft(sessionId)
      updateRevertState(null)
    } catch (error) {
      console.error('Failed to redo all:', error)
    }
  }, [sessionId, revertState, isStreaming, updateRevertState])

  const canUndo = Boolean(sessionId && !isStreaming && items.some(item => item.kind === 'user_message'))
  const canRedo = Boolean(
    sessionId &&
    !isStreaming &&
    revertState &&
    revertState.restored < revertState.checkpoints.length &&
    revertPositions?.has(headLeafId),
  )
  const revertSteps = revertState ? revertState.checkpoints.length - revertState.restored : 0

  // Outline index (reuses ChatArea's visible-id tracking + imperative scroll)
  const chatAreaRef = useRef<ChatAreaHandle>(null)
  const modelSelectorRef = useRef<ModelSelectorHandle | null>(null)
  const [visibleMessageIds, setVisibleMessageIds] = useState<string[]>([])
  const visibleMessageIdsRef = useRef<string[]>([])
  const [isAtBottom, setIsAtBottom] = useState(true)
  const handleVisibleIdsChange = useCallback((ids: string[]) => {
    const prev = visibleMessageIdsRef.current
    if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return
    visibleMessageIdsRef.current = ids
    setVisibleMessageIds(ids)
  }, [])
  const handleOutlineScrollToMessage = useCallback((messageId: string) => {
    chatAreaRef.current?.scrollToMessageId(messageId)
  }, [])
  const outlineEntries = useMemo(() => buildOutlineSourceEntries(items), [items])

  // Mount ChatArea only after this session's branch data is ready — the
  // virtual scroller's cold-start logic estimates the initial offset at
  // the bottom on mount. Home mounts immediately with an empty flow.
  const chatAreaMountKey = sessionId ? (branch ? sessionId : null) : 'home'
  // Assume at-bottom on session remount so the scroll-to-bottom button
  // doesn't flash.（渲染期间调整 state，避免 effect 级联渲染）
  const [lastMountKey, setLastMountKey] = useState(chatAreaMountKey)
  if (chatAreaMountKey !== lastMountKey) {
    setLastMountKey(chatAreaMountKey)
    setIsAtBottom(true)
  }

  // Input box height -> ChatArea bottom spacer (messages scroll under the
  // dock). Seed with the typical expanded height so the spacer never falls
  // back to the 256px default before ResizeObserver reports.
  const [inputBoxHeight, setInputBoxHeight] = useState(96)
  const inputBoxWrapperRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = inputBoxWrapperRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const height = entries[0]?.contentRect.height ?? 0
      setInputBoxHeight(height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ============================================
  // Extension editor bridge: extension set/paste -> composer; composer
  // text -> extension editor state (debounced)
  // ============================================
  const inputBoxRef = useRef<InputBoxHandle>(null)
  const extensionState = useSyncExternalStore(
    extensionUiStore.subscribe,
    () => (sessionId ? extensionUiStore.getSnapshot().sessions[sessionId]?.state : undefined),
    () => undefined,
  )
  useEffect(() => {
    if (!extensionState || extensionState.editorText === lastEditorTextRef.current) return
    lastEditorTextRef.current = extensionState.editorText
    inputBoxRef.current?.setEditorText(extensionState.editorText)
  }, [extensionState])

  const editorSyncTimerRef = useRef<number | null>(null)
  const refreshTimerRefs = useRef(new Set<number>())
  const scheduleDelayedRefresh = useCallback((sid: string) => {
    const timer = window.setTimeout(() => {
      refreshTimerRefs.current.delete(timer)
      void refreshPiBranch(sid).catch(() => undefined)
      void refreshPiSessionState(sid).catch(() => undefined)
    }, 120)
    refreshTimerRefs.current.add(timer)
  }, [])

  useEffect(() => {
    const timerRefs = refreshTimerRefs.current
    return () => {
      if (editorSyncTimerRef.current !== null) {
        window.clearTimeout(editorSyncTimerRef.current)
        editorSyncTimerRef.current = null
      }
      for (const timer of timerRefs) window.clearTimeout(timer)
      timerRefs.clear()
    }
  }, [activeServer?.id, activeServer?.token, activeServer?.url, sessionId])

  const handleTextChange = useCallback(
    (text: string) => {
      // 会话已不可用时别再往服务端同步编辑器状态（每敲一个字一个 404）
      if (!sessionId || sessionUnavailableRef.current) return
      if (editorSyncTimerRef.current !== null) window.clearTimeout(editorSyncTimerRef.current)
      editorSyncTimerRef.current = window.setTimeout(() => {
        editorSyncTimerRef.current = null
        void setPiExtensionEditorState(sessionId, text).catch(() => undefined)
      }, 500)
    },
    [sessionId],
  )
  const handleSend = useCallback(
    async (text: string, attachments: Attachment[], options?: { delivery?: 'steer' | 'followUp' }) => {
      // Native image blocks from data-url attachments (pi only accepts
      // ImageContent; backend also validates model image support)
      const images = attachments
        .map(attachmentToImage)
        .filter((image): image is PiImageInput => image !== null)
      // Unified native entry; deliverAs required while streaming — default
      // to followUp (don't interrupt the running turn)
      const deliverAs = options?.delivery ?? (isStreaming ? 'followUp' : undefined)

      let targetSessionId = sessionId
      if (!targetSessionId) {
        // Home: create the session on first send, then enter it. 全局（未选
        // 目录）时落到服务器默认工作区（桌面安装目录），与终端的全局语义一致。
        const directory = currentDirectoryRef.current || (await resolveWorkspacePath())
        if (!directory) return false
        const opened = await openPiSession(directory)
        if (!opened.sessionId) return false
        targetSessionId = opened.sessionId
        trackPiSession(targetSessionId, opened.cwd ?? directory)
        // 本地创建的会话本地就有全部信息，直接进列表——磁盘扫描要等
        // 首个条目落盘才能看到它
        registerSessionRef.current({
          id: targetSessionId,
          directory: opened.cwd ?? directory,
          title: text.trim().slice(0, 60) || i18n.t('chat:sidebar.newChat'),
          firstMessage: text.trim().slice(0, 200),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          path: opened.sessionFile ?? undefined,
        })
        onEnterSessionRef.current?.(targetSessionId, directory)
        // 刷新其他列表消费者（文件夹分组等）；挂起合并保证新会话不被冲掉
        window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
        // Apply the composer's preferred model and thinking level BEFORE the
        // first prompt — afterwards they'd queue behind the active turn and
        // the first turn would run with defaults.
        const preferred = getPreferredModelKey()
        const preferredModel = preferred ? models.find(m => `${m.provider}:${m.id}` === preferred) : undefined
        if (preferredModel) {
          await setPiModel(targetSessionId, preferredModel.provider, preferredModel.id).catch(() => undefined)
        }
        const preferredVariant = preferred ? getModelVariantPref(preferred) : undefined
        if (preferredVariant) {
          await setPiThinkingLevel(targetSessionId, preferredVariant).catch(() => undefined)
        }
        void refreshPiSessionState(targetSessionId).catch(() => undefined)
      }
      const sid = targetSessionId

      // pi TUI parity: `!command` runs one-shot bash through the runtime
      if (text.startsWith('!') && text.length > 1) {
        const clientId = crypto.randomUUID()
        bashPendingStore.add(sid, clientId, text.slice(1))
        void executePiBash(sid, text.slice(1), undefined, clientId).catch(error => {
          console.error('Failed to run bash command:', error)
        })
        scheduleDelayedRefresh(sid)
        return true
      }

      // Fire and refresh: the prompt command stays open for the whole turn,
      // so awaiting it would block the composer until the turn ends. Return
      // immediately; the event stream drives updates, and we kick the first
      // refresh so the user message shows without waiting for the debounce.
      // 发送失败必须让用户看见——静默丢掉一条消息比报错糟糕得多
      clearSessionEditorDraft(sid)
      setForkSeedText(undefined)
      void sendPiUserMessage(sid, text, images.length ? images : undefined, deliverAs).catch(error => {
        uiErrorHandler('send message', error)
        void refreshPiBranch(sid).catch(() => undefined)
        void refreshPiSessionState(sid).catch(() => undefined)
      })
      scheduleDelayedRefresh(sid)
      return true
    },
    [sessionId, isStreaming, models, scheduleDelayedRefresh],
  )

  // Slash command dispatch, mirroring pi TUI: frontend built-ins are handled
  // locally; everything else goes through the native prompt path, where the
  // SDK executes extension commands and expands skills/prompt templates.
  const handleCommand = useCallback(
    async (commandStr: string): Promise<boolean> => {
      const trimmed = commandStr.trim()
      const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
      const spaceIndex = withoutSlash.indexOf(' ')
      const command = spaceIndex > 0 ? withoutSlash.slice(0, spaceIndex) : withoutSlash
      const args = spaceIndex > 0 ? withoutSlash.slice(spaceIndex + 1).trim() : ''
      if (!command) return false

      // 命令反馈日志：每个命令的执行结果（完整消息）都进扩展面板的"命令反馈"区，
      // 通知只是瞬时的缩略提示。
      // 自动展开：设置开启时，执行完命令把右侧面板切到扩展 tab（打开自身界面的命令除外）。
      const report = (status: CommandFeedbackStatus, message: string, forSession: string | null = sessionId) => {
        commandFeedbackStore.add({
          sessionId: forSession ?? sessionId ?? '',
          command,
          args: args || undefined,
          status,
          message,
        })
        if (themeStore.autoExpandExtensionsOnCommand && !AUTO_EXPAND_EXCLUDED.has(command)) {
          layoutStore.addExtensionsTab('right')
        }
      }

      if (command === 'new') {
        report('info', 'Started a new session')
        onNewChatRef.current?.()
        return true
      }

      if (command === 'settings') {
        report('info', 'Opened the settings panel')
        onOpenSettings?.()
        return true
      }

      if (command === 'hotkeys') {
        report('info', 'Opened keyboard shortcuts')
        onOpenSettingsTab?.('keybindings')
        return true
      }

      if (command === 'changelog') {
        report('info', 'Opened the changelog (About)')
        onOpenSettingsTab?.('about')
        return true
      }

      if (command === 'resume') {
        report('info', 'Opened the session list — pick a session to resume')
        onOpenSidebar?.()
        return true
      }

      if (command === 'model' && !args) {
        report('info', 'Opened the model selector')
        modelSelectorRef.current?.openMenu()
        return true
      }

      let targetSessionId = sessionId
      if (!targetSessionId) {
        const directory = currentDirectoryRef.current
        if (!directory) return false
        const opened = await openPiSession(directory)
        if (!opened.sessionId) return false
        targetSessionId = opened.sessionId
        onEnterSessionRef.current?.(targetSessionId, directory)
      }
      const sid = targetSessionId

      if (command === 'compact') {
        // 启动即有反馈（SDK 无压缩进度流，只有 start/end 事件）——先记一条
        // "已开始"，避免干等；结束再记结果。
        report('info', 'Compaction started — this can take a while (no progress stream from the SDK)', sid)
        void compactPiSession(sid, args || undefined)
          .then(async result => {
            const details = result && typeof result === 'object' && !Array.isArray(result)
              ? result as Record<string, unknown>
              : {}
            const skipped = details.status === 'skipped'
            const message = typeof details.message === 'string'
              ? details.message
              : skipped ? i18n.t('chat:notification.nothingToCompact') : i18n.t('chat:notification.contextCompacted')
            report(skipped ? 'info' : 'ok', message, sid)
            notificationStore.push(
              'completed',
              skipped ? i18n.t('chat:notification.compactSkipped') : i18n.t('chat:notification.compactCompleted'),
              message,
              sid,
              currentDirectoryRef.current,
            )
            await Promise.all([
              refreshPiBranch(sid),
              refreshPiSessionState(sid),
            ])
          })
          .catch(error => {
            console.error('Failed to compact session:', error)
            const message = error instanceof Error ? error.message : String(error)
            report('error', `Compaction failed: ${message}`, sid)
            notificationStore.push(
              'error',
              i18n.t('chat:notification.compactFailed'),
              message,
              sid,
              currentDirectoryRef.current,
            )
          })
        return true
      }

      // /bash <command> — 斜杠命令形式的 one-shot bash（pi TUI `!` 前缀的对应物）
      if (command === 'bash') {
        if (!args) {
          report('error', 'Usage: /bash <command>', sid)
          notificationStore.push('error', '/bash', 'Usage: /bash <command>', sid, currentDirectoryRef.current)
          return true
        }
        report('ok', `Running: ${args}`, sid)
        const clientId = crypto.randomUUID()
        bashPendingStore.add(sid, clientId, args)
        void executePiBash(sid, args, undefined, clientId).catch(error => {
          console.error('Failed to run bash command:', error)
          const message = error instanceof Error ? error.message : String(error)
          report('error', `bash failed: ${message}`, sid)
          notificationStore.push(
            'error',
            '/bash',
            message,
            sid,
            currentDirectoryRef.current,
          )
        })
        scheduleDelayedRefresh(sid)
        return true
      }

      // /share — pi TUI 的 gist 分享依赖本机 gh CLI，Web 客户端暂不提供
      if (command === 'share') {
        report('info', 'Gist sharing needs the gh CLI on the server host; use /export to save the session instead', sid)
        notificationStore.push(
          'completed',
          '/share',
          'Gist sharing needs the gh CLI on the server host; use /export to save the session instead',
          sid,
          currentDirectoryRef.current,
        )
        return true
      }

      if (command === 'reload') {
        try {
          await reloadPiSessionResources(sid)
          report('ok', 'Pi resources reloaded (keybindings, extensions, skills, prompts, themes, context files)', sid)
          notificationStore.push(
            'completed',
            '/reload',
            'Pi resources reloaded',
            sid,
            currentDirectoryRef.current,
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          report('error', `Reload failed: ${message}`, sid)
          notificationStore.push(
            'error',
            '/reload',
            message,
            sid,
            currentDirectoryRef.current,
          )
        }
        return true
      }

      if (command === 'model') {
        const requested = args.includes(':') ? args : args.split(/\s+/).slice(0, 2).join(':')
        const model = models.find(item => `${item.provider}:${item.id}` === requested)
        if (!model) {
          report('error', `Unknown model: ${args}`, sid)
          notificationStore.push('error', '/model', `Unknown model: ${args}`, sid, currentDirectoryRef.current)
          return true
        }
        report('ok', `Switched to ${model.provider}/${model.id}`, sid)
        handleModelChange(requested, model)
        return true
      }

      if (command === 'scoped-models') {
        const patterns = args.split(/[\s,]+/).map(value => value.trim()).filter(Boolean)
        if (patterns.length === 0) {
          report('info', 'Opened scoped-model settings', sid)
          onOpenSettingsTab?.('config')
          return true
        }
        await setPiScopedModels(sid, patterns)
        await refreshPiSessionState(sid)
        report('ok', `Scoped models: ${patterns.join(', ')}`, sid)
        return true
      }

      if (command === 'name') {
        if (!args) {
          const currentName = state?.sessionName
          report('info', typeof currentName === 'string' && currentName ? `Current name: ${currentName}` : 'Session has no name', sid)
          notificationStore.push('completed', '/name', typeof currentName === 'string' && currentName ? currentName : 'Session has no name', sid, currentDirectoryRef.current)
          return true
        }
        await renamePiSession(sid, args)
        report('ok', `Renamed session to "${args}"`, sid)
        return true
      }

      if (command === 'copy') {
        const lastAssistant = [...items].reverse().find(item => item.kind === 'assistant_message')
        const text = lastAssistant ? textFromTimelineItem(lastAssistant) : ''
        if (!text) {
          report('error', 'No AI response to copy', sid)
          notificationStore.push('error', '/copy', 'No AI response to copy', sid, currentDirectoryRef.current)
          return true
        }
        await copyTextToClipboard(text)
        report('ok', 'Copied the last AI response to the clipboard', sid)
        notificationStore.push('completed', '/copy', 'AI response copied', sid, currentDirectoryRef.current)
        return true
      }

      if (command === 'clone') {
        const result = await newPiSessionFrom(sid)
        if (result.targetSessionId) {
          report('ok', `Cloned into a new session ${result.targetSessionId}`, sid)
          onEnterSessionRef.current?.(result.targetSessionId, result.targetCwd ?? currentDirectoryRef.current ?? '')
        }
        return true
      }

      if (command === 'fork') {
        const target = args || [...items].reverse().find(item => item.kind === 'user_message')?.entryId
        if (!target) {
          report('error', 'No user message to fork from', sid)
          notificationStore.push('error', '/fork', 'No user message to fork from', sid, currentDirectoryRef.current)
          return true
        }
        await handleFork(target)
        report('ok', `Forked from entry ${target}`, sid)
        return true
      }

      if (command === 'trust') {
        const decision = args.toLowerCase()
        if (!decision) {
          report('info', 'Opened project trust settings', sid)
          onOpenSettingsTab?.('config')
          return true
        }
        const value = decision === 'yes' || decision === 'true' || decision === 'allow'
          ? true
          : decision === 'no' || decision === 'false' || decision === 'deny'
            ? false
            : decision === 'reset' || decision === 'ask'
              ? null
              : undefined
        if (value === undefined) {
          report('error', 'Use yes, no, or reset', sid)
          notificationStore.push('error', '/trust', 'Use yes, no, or reset', sid, currentDirectoryRef.current)
          return true
        }
        const cwd = currentDirectoryRef.current
        if (!cwd) {
          report('error', 'Open a project before changing trust', sid)
          notificationStore.push('error', '/trust', 'Open a project before changing trust', sid, currentDirectoryRef.current)
          return true
        }
        await setPiProjectTrust(cwd, value)
        report('ok', `Project trust set to ${value === null ? 'ask' : value ? 'trusted' : 'denied'}: ${cwd}`, sid)
        return true
      }

      if (command === 'logout') {
        if (!args) {
          report('info', 'Opened provider settings', sid)
          onOpenSettingsTab?.('config')
          return true
        }
        const provider = args.split(/\s+/)[0]!
        await logoutPiProvider(provider)
        report('ok', `Logged out of ${provider}`, sid)
        return true
      }

      if (command === 'login') {
        if (!args) {
          report('info', 'Opened provider settings', sid)
          onOpenSettings?.()
          return true
        }
        const provider = args.split(/\s+/)[0]!
        await startPiProviderAuth(provider)
        report('ok', `Started login flow for ${provider}`, sid)
        return true
      }

      if (command === 'export') {
        const outputPath = args || `${(currentDirectoryRef.current || '.').replace(/[\\/]+$/, '')}/pi-session.html`
        const format = outputPath.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'html'
        await exportPiSession(sid, format, outputPath)
        report('ok', `Exported session (${format}) to ${outputPath}`, sid)
        notificationStore.push('completed', '/export', outputPath, sid, currentDirectoryRef.current)
        return true
      }

      if (command === 'import') {
        if (!args) {
          report('error', 'Provide a session JSONL path', sid)
          notificationStore.push('error', '/import', 'Provide a session JSONL path', sid, currentDirectoryRef.current)
          return true
        }
        const result = await importPiSession(sid, args)
        if (result.targetSessionId) {
          report('ok', `Imported session ${result.targetSessionId} from ${args}`, sid)
          onEnterSessionRef.current?.(result.targetSessionId, result.targetCwd ?? currentDirectoryRef.current ?? '')
        }
        return true
      }

      if (command === 'tree') {
        // 跳到右侧会话树标签（而不是 toggle：面板已开时不会把它关掉）
        report('info', 'Opened the session tree panel')
        layoutStore.addSessionTreeTab('right')
        return true
      }

      if (command === 'session') {
        const model = state?.model as { provider?: string; id?: string } | undefined
        const stats = state?.sessionStats as { totalMessages?: number; userMessages?: number; assistantMessages?: number; toolCalls?: number } | undefined
        const summary = [
          typeof state?.sessionName === 'string' && state.sessionName ? state.sessionName : sid,
          model?.provider && model.id ? `${model.provider}/${model.id}` : undefined,
          stats ? `${stats.totalMessages ?? 0} messages · ${stats.userMessages ?? 0} user · ${stats.assistantMessages ?? 0} assistant · ${stats.toolCalls ?? 0} tool calls` : undefined,
        ].filter(Boolean).join(' · ')
        report('ok', summary, sid)
        notificationStore.push('completed', '/session', summary, sid, currentDirectoryRef.current)
        return true
      }

      if (command === 'quit') {
        report('info', 'The web app stays open; close its window to exit', sid)
        notificationStore.push('completed', '/quit', 'The web app stays open; close its window to exit', sid, currentDirectoryRef.current)
        return true
      }

      const registry = await loadPiSessionRegistry(sid)
      const registered = registry?.commands.find(item => item.name === command)
      const sourceInfo = registered?.sourceInfo
      const isBuiltin = Boolean(sourceInfo && typeof sourceInfo === 'object' && !Array.isArray(sourceInfo) && sourceInfo.builtin === true)
      if (isBuiltin) {
        report('error', 'This Pi command needs a GUI interaction that is not available here yet', sid)
        notificationStore.push('error', `/${command}`, 'This Pi command needs a GUI interaction that is not available here yet', sid, currentDirectoryRef.current)
        return true
      }

      // 扩展命令（如 /exa /ui-test-*）：真正调用扩展注册的 handler，而不是
      // 当普通消息发给模型（那只会让模型回答一段"这不是命令"的废话）。
      if (registered) {
        report('ok', `Invoking extension command /${command}${args ? ` ${args}` : ''}`, sid)
        try {
          const result = await invokePiCommand(sid, command, args)
          const summary = typeof result === 'string' && result ? result : ''
          if (summary) report('ok', summary, sid)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          report('error', `/${command} failed: ${message}`, sid)
        }
        scheduleDelayedRefresh(sid)
        return true
      }

      report('info', `Sent "${trimmed}" to the model (not a known command)`, sid)
      void sendPiPrompt(sid, trimmed, {
        streamingBehavior: isStreaming ? 'followUp' : undefined,
      }).catch(error => {
        console.error('Failed to execute command:', error)
      })
      scheduleDelayedRefresh(sid)
      return true
    },
    [currentDirectoryRef, handleFork, handleModelChange, isStreaming, items, models, onOpenSettings, onOpenSettingsTab, onOpenSidebar, scheduleDelayedRefresh, sessionId, state],
  )

  // Image attachment capability from the current model's native input
  // kinds; home (unknown default model) optimistically allows when any
  // catalog model supports images — backend validates on send.
  const imageCapable = currentModelObj
    ? currentModelObj.input.includes('image')
    : models.some(model => model.input.includes('image'))

  // ============================================
  // Pane focus + drag & drop (ocui shell behavior)
  // ============================================
  const splitPaneEnabled = displayMode === 'split' || paneCount > 1 || Boolean(onSplitPane)
  const handlePaneFocus = useCallback(() => {
    paneLayoutStore.focusPane(paneId)
  }, [paneId])

  const overlayRef = useRef<PaneDropOverlayHandle>(null)
  const paneRootRef = useRef<HTMLDivElement>(null)
  const isFolderDropActive = useFolderProjectDrop(paneRootRef, addDirectory)
  const currentZoneRef = useRef<DropZone | null>(null)
  const pendingZoneRef = useRef<DropZone | null>(null)
  const dropRafRef = useRef<number | null>(null)

  const writeZone = useCallback((zone: DropZone | null) => {
    if (currentZoneRef.current === zone) return
    currentZoneRef.current = zone
    overlayRef.current?.setZone(zone)
  }, [])

  const cancelPendingZone = useCallback(() => {
    if (dropRafRef.current !== null) {
      cancelAnimationFrame(dropRafRef.current)
      dropRafRef.current = null
    }
    pendingZoneRef.current = null
  }, [])

  const resetDropState = useCallback(() => {
    cancelPendingZone()
    writeZone(null)
  }, [cancelPendingZone, writeZone])

  useEffect(() => {
    return () => {
      if (dropRafRef.current !== null) cancelAnimationFrame(dropRafRef.current)
    }
  }, [])

  const updateSessionDropZoneAt = useCallback(
    (clientX: number, clientY: number) => {
      if (!splitPaneEnabled) return null
      const element = paneRootRef.current
      if (!element) return null
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null

      const xRel = (clientX - rect.left) / rect.width
      const yRel = (clientY - rect.top) / rect.height
      const zone = resolveDropZone({ xRel, yRel })
      pendingZoneRef.current = zone

      if (dropRafRef.current === null) {
        dropRafRef.current = requestAnimationFrame(() => {
          dropRafRef.current = null
          writeZone(pendingZoneRef.current)
        })
      }

      return zone
    },
    [splitPaneEnabled, writeZone],
  )

  const clearSessionDropZoneAt = useCallback(
    (clientX: number, clientY: number) => {
      const element = paneRootRef.current
      if (!element) return resetDropState()
      const rect = element.getBoundingClientRect()
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        resetDropState()
      }
    },
    [resetDropState],
  )

  const handleSessionDrop = useCallback(
    (payload: { sessionId: string; directory?: string }, zone: DropZone) => {
      resetDropState()
      cancelPendingSplitSessionNavigation()

      if (payload.sessionId === sessionId && zone === 'center') return

      if (zone === 'center') {
        navigatePaneToSession?.(paneId, payload.sessionId, payload.directory)
        return
      }

      const previousFocusedPaneId = paneLayoutStore.getFocusedPaneId()
      const newPaneId = paneLayoutStore.splitPaneToSide(paneId, zone, null)
      if (newPaneId) {
        if (previousFocusedPaneId && paneLayoutStore.findLeaf(previousFocusedPaneId)) {
          paneLayoutStore.focusPane(previousFocusedPaneId)
        }

        scheduleSplitSessionNavigation(() => {
          if (!paneLayoutStore.findLeaf(newPaneId)) return
          navigatePaneToSession?.(newPaneId, payload.sessionId, payload.directory)
        })
      }
    },
    [paneId, sessionId, navigatePaneToSession, resetDropState],
  )

  useEffect(() => {
    return subscribeInternalDrag(() => {
      const active = getInternalDragSnapshot().active
      if (!active || active.payload.kind !== 'session') {
        resetDropState()
        return
      }

      const zone = updateSessionDropZoneAt(active.current.x, active.current.y)
      if (!zone) clearSessionDropZoneAt(active.current.x, active.current.y)
    })
  }, [clearSessionDropZoneAt, resetDropState, updateSessionDropZoneAt])

  useEffect(() => {
    return subscribeInternalDrop(event => {
      if (event.payload.kind !== 'session') return
      const zone = updateSessionDropZoneAt(event.point.x, event.point.y)
      if (!zone) {
        resetDropState()
        return
      }

      handleSessionDrop(
        {
          sessionId: event.payload.sessionId,
          directory: event.payload.directory,
        },
        zone,
      )
    })
  }, [handleSessionDrop, resetDropState, updateSessionDropZoneAt])

  // ============================================
  // Shell (ocui structure)
  // ============================================
  const showCompactShell = displayMode === 'split' && !isPaneFullscreen
  const outerViewport = useChatViewportMaybe()

  const navigationCtx = useMemo<SessionNavigationContextValue>(
    () => ({
      navigateToSession: (sid, dir) => navigatePaneToSession?.(paneId, sid, dir),
      currentSessionId: sessionId,
      currentDirectory: currentDirectory ?? undefined,
    }),
    [navigatePaneToSession, paneId, sessionId, currentDirectory],
  )

  const chatContent = (
    <div className="flex-1 relative overflow-hidden flex flex-col min-h-0">
      {displayMode === 'single' && (
        <div className="absolute top-0 left-0 right-0 z-20 pointer-events-none">
          <div className="pointer-events-auto">
            <Header
              sessionId={sessionId}
              models={[...models]}
              modelsLoading={modelsLoading}
              selectedModelKey={selectedModelKey}
              onModelChange={handleModelChange}
              onOpenSidebar={onOpenSidebar}
              onToggleRightPanel={onToggleRightPanel}
              onSplitPane={onSplitPane}
              isPaneFullscreen={isPaneFullscreen}
              onTogglePaneFullscreen={onTogglePaneFullscreen}
              modelSelectorRef={modelSelectorRef}
            />
          </div>
        </div>
      )}

      <div className="absolute inset-0">
        {sessionUnavailable || sessionLoadError ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-text-400 max-w-xs text-center">
              <p className="text-[length:var(--fs-md)] font-medium text-text-200">
                {sessionUnavailable
                  ? t('chat:chatArea.sessionNotFound')
                  : sessionBusy
                    ? t('chat:chatArea.sessionBusy')
                    : t('chat:chatArea.sessionLoadFailed')}
              </p>
              <p className="text-[length:var(--fs-sm)] text-text-400">
                {sessionUnavailable
                  ? t('chat:chatArea.sessionNotFoundDesc')
                  : sessionBusy
                    ? t('chat:chatArea.sessionBusyDesc')
                    : t('chat:chatArea.sessionLoadFailedDesc')}
              </p>
              <button
                type="button"
                onClick={() => void retrySession()}
                disabled={isRetryingSession}
                className="mt-1 h-8 px-3 rounded-md text-[length:var(--fs-sm)] font-medium text-accent-main-100 hover:bg-accent-main-100/10 disabled:opacity-50 transition-colors"
              >
                {isRetryingSession ? t('chat:chatArea.loadingSession') : t('common:retry')}
              </button>
              {sessionLoadError ? null : (
                <button
                  type="button"
                  onClick={() => onNewChatRef.current?.()}
                  className="h-8 px-3 text-[length:var(--fs-sm)] text-text-400 hover:text-text-200 transition-colors"
                >
                  {t('chat:chatArea.backToHome')}
                </button>
              )}
            </div>
          </div>
        ) : chatAreaMountKey == null ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-text-400 session-loading-indicator">
              <span className="w-5 h-5 border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin" />
            </div>
          </div>
        ) : (
          <ChatArea
            key={chatAreaMountKey}
            ref={chatAreaRef}
            items={items}
            queuedSteering={queuedSteering}
            queuedFollowUps={queuedFollowUps}
            sessionId={sessionId}
            isStreaming={isStreaming}
            isCompacting={compacting}
            loadState="loaded"
            hasMoreHistory={Boolean(branch?.hasMore)}
            onLoadMore={handleLoadMore}
            bottomPadding={inputBoxHeight}
            onVisibleMessageIdsChange={handleVisibleIdsChange}
            onAtBottomChange={setIsAtBottom}
            onFork={handleFork}
            onUndo={canUndo ? handleUndo : undefined}
            canUndo={canUndo}
          />
        )}
      </div>

      <OutlineIndex
        sourceEntries={outlineEntries}
        visibleMessageIds={visibleMessageIds}
        onScrollToMessageId={handleOutlineScrollToMessage}
      />

      <ExtensionUiDialogHost
        sessionId={sessionId}
        collapsed={dialogCollapsed}
        onCollapsedChange={setDialogCollapsed}
      />

      <ProjectTrustPrompt cwd={currentDirectory} />

      <div ref={inputBoxWrapperRef} className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none">
        <div className="pointer-events-auto">
          <InputBox
            ref={inputBoxRef}
            paneId={paneId}
            sessionId={sessionId}
            onSend={handleSend}
            onCommand={handleCommand}
            onCycleModel={direction => sessionId && void cyclePiModel(sessionId, direction).then(() => refreshPiSessionState(sessionId)).catch(() => undefined)}
            onCycleThinkingLevel={() => sessionId && void cyclePiThinkingLevel(sessionId).then(() => refreshPiSessionState(sessionId)).catch(() => undefined)}
            onOpenModelSelector={() => modelSelectorRef.current?.openMenu()}
            onTextChange={handleTextChange}
            onAbort={() => (sessionId
              ? void (compacting ? abortPiCompaction(sessionId) : abortPiOperation(sessionId)).catch(() => undefined)
              : undefined)}
            onNewChat={onNewChat}
            isStreaming={isStreaming}
            isCompacting={compacting}
            isAtBottom={isAtBottom}
            showScrollToBottom={!isAtBottom}
            onScrollToBottom={() => chatAreaRef.current?.scrollToBottom()}
            fileCapabilities={{ image: imageCapable, pdf: false, audio: false, video: false }}
            models={[...models]}
            selectedModelKey={selectedModelKey}
            onModelChange={handleModelChange}
            modelsLoading={modelsLoading}
            modelSelectorRef={modelSelectorRef}
            variants={thinkingLevels}
            selectedVariant={thinkingLevel}
            onVariantChange={handleVariantChange}
            revertedText={editorDraft?.text ?? forkSeedText}
            canRedo={canRedo}
            revertSteps={revertSteps}
            onRedo={() => void handleRedoStep()}
            onRedoAll={() => void handleRedoAll()}
            collapsedPermission={
              dialogRequest && dialogCollapsed
                ? {
                    label: dialogRequest.title,
                    queueLength: pendingDialogs.length,
                    onExpand: () => setDialogCollapsed(false),
                  }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  )

  const content = (
    <SessionNavigationContext.Provider value={navigationCtx}>
      <div
        ref={paneRootRef}
        data-chat-pane-root="true"
        className={
          showCompactShell
            ? `relative h-full flex flex-col overflow-hidden rounded-lg transition-colors duration-200 ${
                isFocused
                  ? 'ring-1 ring-accent-main-100/60 bg-bg-100'
                  : 'ring-1 ring-border-200/30 bg-bg-100 hover:ring-border-200/50'
              }`
            : 'relative h-full flex flex-col overflow-hidden bg-bg-100'
        }
        onClick={handlePaneFocus}
      >
        {showCompactShell && (
          <PaneHeader
            paneId={paneId}
            sessionId={sessionId}
            isFocused={isFocused}
            paneCount={paneCount}
            showSidebarButton={showSidebarButton}
            onOpenSidebar={onOpenSidebar}
            onToggleRightPanel={onToggleRightPanel}
            canSplitPane={splitPaneEnabled}
            isPaneFullscreen={isPaneFullscreen}
            onTogglePaneFullscreen={onTogglePaneFullscreen}
            onFocus={handlePaneFocus}
          />
        )}
        {chatContent}
        <PaneDropOverlay ref={overlayRef} />
        <FolderProjectDropOverlay active={isFolderDropActive} />
      </div>
    </SessionNavigationContext.Provider>
  )

  // Always wrap with ChatViewportProvider to keep the React tree structure
  // stable across fullscreen toggles (ocui pattern). Split shell keeps
  // compact presentation but inherits the input-dock setting.
  const viewportValue = useMemo((): ChatViewportValue => {
    if (!showCompactShell) return outerViewport ?? PANE_VIEWPORT
    const enableCollapsedInputDock = outerViewport?.interaction.enableCollapsedInputDock ?? false
    if (enableCollapsedInputDock === PANE_VIEWPORT.interaction.enableCollapsedInputDock) {
      return PANE_VIEWPORT
    }
    return {
      ...PANE_VIEWPORT,
      interaction: {
        ...PANE_VIEWPORT.interaction,
        enableCollapsedInputDock,
      },
    }
  }, [showCompactShell, outerViewport])

  return <ChatViewportProvider value={viewportValue}>{content}</ChatViewportProvider>
}
