import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Model } from '@earendil-works/pi-ai'
import { ChatArea, Header, InputBox, type ChatAreaHandle, type InputBoxHandle } from '../chat/index.js'
import type { ModelSelectorHandle } from '../chat/ModelSelector.js'
import { PaneHeader } from '../chat/PaneHeader.js'
import { PaneDropOverlay, resolveDropZone, type DropZone, type PaneDropOverlayHandle } from '../chat/PaneDropOverlay.js'
import { useFolderProjectDrop } from '../chat/useFolderProjectDrop.js'
import { FolderProjectDropOverlay } from '../chat/FolderProjectDropOverlay.js'
import { ChatViewportProvider, useChatViewportMaybe, type ChatViewportValue } from '../chat/chatViewport.js'
import type { Attachment } from '../attachment/index.js'
import { ExtensionUiDialogHost } from '../chat/ExtensionUiDialogHost.js'
import { OutlineIndex } from '../../components/OutlineIndex'
import { buildOutlineSourceEntries } from '../../components/outlineIndexModel'
import { selectPiTimelineItems } from '../../pi/selectors/index.js'
import { piEventStream } from '../../pi/eventStream.js'
import {
  abortPiOperation,
  compactPiSession,
  forkPiSession,
  loadMorePiBranchEntries,
  refreshPiBranch,
  refreshPiSessionState,
  loadPiModels,
  loadPiSessionData,
  openPiSession,
  sendPiPrompt,
  sendPiUserMessage,
  setPiExtensionEditorState,
  setPiModel,
  setPiThinkingLevel,
} from '../../pi/controllers/index.js'
import type { PiImageInput } from '../../pi/transport/index.js'
import { piBranchStore } from '../../pi/state/index.js'
import { extensionUiStore } from '../../pi/extensionUiStore'
import { usePiBranchData, usePiModels, usePiSessionRuntimeState } from '../../pi/hooks/index.js'
import { useDirectory } from '../../contexts/useDirectory'
import { SessionNavigationContext, type SessionNavigationContextValue } from '../../contexts/SessionNavigationContext'
import { paneLayoutStore } from '../../store/paneLayoutStore'
import { getInternalDragSnapshot, subscribeInternalDrag, subscribeInternalDrop } from '../../lib/internalDragCore'
import { recordModelUsage } from '../../utils/modelUtils'

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

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
  onToggleRightPanel?: () => void
  onSplitPane?: () => void
  onTogglePaneFullscreen?: () => void
  showSidebarButton?: boolean
  navigatePaneToSession?: (paneId: string, sessionId: string, directory?: string) => void
}

/** Convert a data-url attachment to a native ImageContent block */
function attachmentToImage(attachment: Attachment): PiImageInput | null {
  if (!attachment.url?.startsWith('data:') || !attachment.mime?.startsWith('image/')) return null
  const commaIndex = attachment.url.indexOf(',')
  if (commaIndex === -1) return null
  return { type: 'image', data: attachment.url.slice(commaIndex + 1), mimeType: attachment.mime }
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
  onToggleRightPanel,
  onSplitPane,
  onTogglePaneFullscreen,
  showSidebarButton = false,
  navigatePaneToSession,
}: PiChatPaneProps) {
  const onEnterSessionRef = useRef(onEnterSession)
  onEnterSessionRef.current = onEnterSession
  const onNewChatRef = useRef(onNewChat)
  onNewChatRef.current = onNewChat
  const { currentDirectory, addDirectory } = useDirectory()
  const currentDirectoryRef = useRef(currentDirectory)
  currentDirectoryRef.current = currentDirectory

  // ============================================
  // Pi data layer: event stream + keyed stores
  // ============================================
  useEffect(() => {
    if (!sessionId) return
    piEventStream.connect(sessionId)
    if (!piBranchStore.getData(sessionId)) {
      void loadPiSessionData(sessionId).catch(() => undefined)
    }
    return () => piEventStream.disconnect(sessionId)
  }, [sessionId])

  const { models, isLoading: modelsLoading } = usePiModels()
  useEffect(() => {
    void loadPiModels().catch(() => undefined)
  }, [])

  const branch = usePiBranchData(sessionId)
  const state = usePiSessionRuntimeState(sessionId)

  const isStreaming = Boolean(state?.isStreaming)
  const queue = state?.queue as { steering?: string[]; followUp?: string[] } | undefined

  // Timeline items from this session's keyed branch; home (no session)
  // shows an empty flow — user types and sends to create one.
  const items = useMemo(() => (branch ? selectPiTimelineItems(branch) : []), [branch])

  // Current model from runtime state (native SDK shape)
  const currentModel = state?.model as { provider?: string; id?: string } | null | undefined
  const selectedModelKey =
    currentModel?.provider && currentModel?.id ? `${currentModel.provider}:${currentModel.id}` : null

  // Thinking level: variants filtered by the current model's support map,
  // current value from runtime state — the native home for this control.
  const currentModelObj = useMemo(
    () => models.find(m => m.provider === currentModel?.provider && m.id === currentModel?.id),
    [models, currentModel?.provider, currentModel?.id],
  )
  const thinkingLevels = useMemo(() => {
    if (!currentModelObj?.reasoning) return ['off']
    const map = currentModelObj.thinkingLevelMap as Record<string, string | null> | undefined
    return PI_THINKING_LEVELS.filter(level => !map || map[level] !== null)
  }, [currentModelObj])
  const thinkingLevel = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : undefined

  const handleVariantChange = useCallback(
    (variant: string | undefined) => {
      if (!sessionId || !variant) return
      void setPiThinkingLevel(sessionId, variant).catch(() => undefined)
    },
    [sessionId],
  )

  const handleModelChange = useCallback(
    (_modelKey: string, model: Model<any>) => {
      if (!sessionId) return
      recordModelUsage(model)
      void setPiModel(sessionId, model.provider, model.id).catch(() => undefined)
    },
    [sessionId],
  )

  // Fork at a message (native fork: runtime switches to the new session
  // file; the pane follows it). forkMessageId is the merged tail entry id
  // from ChatArea's visibility model.
  const handleFork = useCallback(
    async (entryId: string, forkMessageId?: string) => {
      if (!sessionId) return
      try {
        const result = await forkPiSession(sessionId, forkMessageId ?? entryId, 'at')
        if (result.cancelled || !result.targetSessionId) return
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
  // doesn't flash.
  useEffect(() => {
    if (chatAreaMountKey == null) return
    setIsAtBottom(true)
  }, [chatAreaMountKey])

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
  const lastEditorTextRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!extensionState || extensionState.editorText === lastEditorTextRef.current) return
    lastEditorTextRef.current = extensionState.editorText
    inputBoxRef.current?.setEditorText(extensionState.editorText)
  }, [extensionState])

  const editorSyncTimerRef = useRef<number | null>(null)
  const handleTextChange = useCallback(
    (text: string) => {
      if (!sessionId) return
      if (editorSyncTimerRef.current !== null) window.clearTimeout(editorSyncTimerRef.current)
      editorSyncTimerRef.current = window.setTimeout(() => {
        editorSyncTimerRef.current = null
        void setPiExtensionEditorState(sessionId, text).catch(() => undefined)
      }, 500)
    },
    [sessionId],
  )
  useEffect(() => {
    return () => {
      if (editorSyncTimerRef.current !== null) window.clearTimeout(editorSyncTimerRef.current)
    }
  }, [])

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
        // Home: create the session on first send, then enter it
        const directory = currentDirectoryRef.current
        if (!directory) return false
        const opened = await openPiSession(directory)
        if (!opened.sessionId) return false
        targetSessionId = opened.sessionId
        piEventStream.connect(targetSessionId)
        onEnterSessionRef.current?.(targetSessionId, directory)
      }
      const sid = targetSessionId

      // Fire and refresh: the prompt command stays open for the whole turn,
      // so awaiting it would block the composer until the turn ends. Return
      // immediately; the event stream drives updates, and we kick the first
      // refresh so the user message shows without waiting for the debounce.
      void sendPiUserMessage(sid, text, images.length ? images : undefined, deliverAs).catch(error => {
        console.error('Failed to send message:', error)
      })
      window.setTimeout(() => {
        void refreshPiBranch(sid).catch(() => undefined)
        void refreshPiSessionState(sid).catch(() => undefined)
      }, 120)
      return true
    },
    [sessionId, isStreaming],
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

      if (command === 'new') {
        onNewChatRef.current?.()
        return true
      }

      let targetSessionId = sessionId
      if (!targetSessionId) {
        const directory = currentDirectoryRef.current
        if (!directory) return false
        const opened = await openPiSession(directory)
        if (!opened.sessionId) return false
        targetSessionId = opened.sessionId
        piEventStream.connect(targetSessionId)
        onEnterSessionRef.current?.(targetSessionId, directory)
      }
      const sid = targetSessionId

      if (command === 'compact') {
        void compactPiSession(sid, args || undefined).catch(error => {
          console.error('Failed to compact session:', error)
        })
        return true
      }

      void sendPiPrompt(sid, trimmed, {
        streamingBehavior: isStreaming ? 'followUp' : undefined,
      }).catch(error => {
        console.error('Failed to execute command:', error)
      })
      window.setTimeout(() => {
        void refreshPiBranch(sid).catch(() => undefined)
        void refreshPiSessionState(sid).catch(() => undefined)
      }, 120)
      return true
    },
    [sessionId, isStreaming],
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
        {chatAreaMountKey == null ? (
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
            queuedSteering={queue?.steering ?? []}
            queuedFollowUps={queue?.followUp ?? []}
            sessionId={sessionId}
            isStreaming={isStreaming}
            allowStreamingLayoutAnimation
            loadState="loaded"
            hasMoreHistory={Boolean(branch?.hasMore)}
            onLoadMore={() => (sessionId ? loadMorePiBranchEntries(sessionId) : undefined)}
            bottomPadding={inputBoxHeight}
            onVisibleMessageIdsChange={handleVisibleIdsChange}
            onAtBottomChange={setIsAtBottom}
            onFork={handleFork}
          />
        )}
      </div>

      <OutlineIndex
        sourceEntries={outlineEntries}
        visibleMessageIds={visibleMessageIds}
        onScrollToMessageId={handleOutlineScrollToMessage}
      />

      <ExtensionUiDialogHost sessionId={sessionId} />

      <div ref={inputBoxWrapperRef} className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none">
        <div className="pointer-events-auto">
          <InputBox
            ref={inputBoxRef}
            paneId={paneId}
            sessionId={sessionId}
            onSend={handleSend}
            onCommand={handleCommand}
            onTextChange={handleTextChange}
            onAbort={() => (sessionId ? void abortPiOperation(sessionId).catch(() => undefined) : undefined)}
            onNewChat={onNewChat}
            isStreaming={isStreaming}
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
