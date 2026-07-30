import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Model } from '@earendil-works/pi-ai'
import { ChatArea, Header, InputBox, type ChatAreaHandle } from '../chat/index.js'
import type { ModelSelectorHandle } from '../chat/ModelSelector.js'
import type { Attachment } from '../attachment/index.js'
import { OutlineIndex } from '../../components/OutlineIndex'
import { buildOutlineSourceEntries } from '../../components/outlineIndexModel'
import { selectPiTimelineItems } from '../../pi/selectors/index.js'
import { piEventStream } from '../../pi/eventStream.js'
import {
  abortPiOperation,
  loadMorePiBranchEntries,
  loadPiModels,
  loadPiSessionData,
  sendPiFollowUp,
  sendPiPrompt,
  sendPiSteer,
  setPiModel,
  setPiThinkingLevel,
} from '../../pi/controllers/index.js'
import { piBranchStore, piSessionStateStore } from '../../pi/state/index.js'
import { usePiBranchData, usePiModels, usePiSessionRuntimeState } from '../../pi/hooks/index.js'
import { recordModelUsage } from '../../utils/modelUtils'
import type { PiBranchPage } from '../../pi/domain/index.js'

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Session id that owns this branch page (from the persisted session header).
 */
function branchSessionIdOf(branch: PiBranchPage): string | null {
  const header = branch.head.header
  if (header && typeof header === 'object' && 'id' in header && typeof header.id === 'string') {
    return header.id
  }
  return null
}

interface PiChatPaneProps {
  paneId: string
  sessionId: string | null
  onOpenSidebar?: () => void
  onToggleRightPanel?: () => void
  onSplitPane?: () => void
  isPaneFullscreen?: boolean
  onTogglePaneFullscreen?: () => void
}

/**
 * Pi-native chat pane. All rendering reuses the existing chat components
 * (Header, ChatArea, OutlineIndex, InputBox); only the data source is new —
 * raw Pi stores via selectors. The event stream keeps stores fresh while
 * the pane is open.
 */
export function PiChatPane({
  paneId,
  sessionId,
  onOpenSidebar,
  onToggleRightPanel,
  onSplitPane,
  isPaneFullscreen = false,
  onTogglePaneFullscreen,
}: PiChatPaneProps) {
  // Self-heal on mount / session switch: connect the event stream and make
  // sure session data belongs to THIS session — the branch store is a
  // singleton, so stale data from the previous session must be dropped
  // before the ChatArea mounts (its cold-start bottom estimate runs once
  // at mount).
  useEffect(() => {
    if (!sessionId) return
    piEventStream.connect(sessionId)
    const current = piBranchStore.getData()
    if (!current || branchSessionIdOf(current) !== sessionId) {
      piBranchStore.clear()
      piSessionStateStore.clear()
      void loadPiSessionData(sessionId).catch(() => undefined)
    }
  }, [sessionId])

  // Models catalog (loaded once per app lifecycle)
  const { models, isLoading: modelsLoading } = usePiModels()
  useEffect(() => {
    void loadPiModels().catch(() => undefined)
  }, [])

  const branch = usePiBranchData()
  const state = usePiSessionRuntimeState()

  const isStreaming = Boolean(state?.isStreaming)
  const queue = state?.queue as { steering?: string[]; followUp?: string[] } | undefined

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

  // Mount ChatArea only after branch data for THIS session is ready — the
  // virtual scroller's cold-start logic estimates the initial offset at the
  // bottom on mount, and it must not see another session's items.
  const branchSessionId = branch ? branchSessionIdOf(branch) : null
  const chatAreaMountKey = branch && branchSessionId === sessionId ? sessionId : null
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

  const handleSend = useCallback(
    async (text: string, _attachments: Attachment[], options?: { delivery?: 'steer' | 'followUp' }) => {
      if (!sessionId) return false
      if (options?.delivery === 'steer') {
        await sendPiSteer(sessionId, text)
      } else if (options?.delivery === 'followUp' || isStreaming) {
        await sendPiFollowUp(sessionId, text)
      } else {
        await sendPiPrompt(sessionId, text)
      }
      return true
    },
    [sessionId, isStreaming],
  )

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center text-[length:var(--fs-sm)] text-text-500">
        Select a session to start chatting
      </div>
    )
  }

  return (
    <div className="flex-1 relative overflow-hidden flex flex-col min-h-0 h-full">
      <div className="absolute top-0 left-0 right-0 z-20 pointer-events-none">
        <div className="pointer-events-auto">
          <Header
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
            onLoadMore={() => loadMorePiBranchEntries(sessionId)}
            bottomPadding={inputBoxHeight}
            onVisibleMessageIdsChange={handleVisibleIdsChange}
            onAtBottomChange={setIsAtBottom}
          />
        )}
      </div>

      <OutlineIndex
        sourceEntries={outlineEntries}
        visibleMessageIds={visibleMessageIds}
        onScrollToMessageId={handleOutlineScrollToMessage}
      />

      <div ref={inputBoxWrapperRef} className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none">
        <div className="pointer-events-auto">
          <InputBox
            paneId={paneId}
            sessionId={sessionId}
            onSend={handleSend}
            onAbort={() => void abortPiOperation(sessionId).catch(() => undefined)}
            isStreaming={isStreaming}
            isAtBottom={isAtBottom}
            showScrollToBottom={!isAtBottom}
            onScrollToBottom={() => chatAreaRef.current?.scrollToBottom()}
            variants={thinkingLevels}
            selectedVariant={thinkingLevel}
            onVariantChange={handleVariantChange}
          />
        </div>
      </div>
    </div>
  )
}
