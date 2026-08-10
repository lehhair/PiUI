/**
 * ChatArea — 基于 @tanstack/react-virtual 的消息流虚拟化
 *
 * 对齐 oc message-timeline 的关键点：
 * 1. parent 在 messages ready 后 key={sessionId} remount
 * 2. mount 时读 sessionCache → initialMeasurementsCache
 * 3. 冷启动 initialOffset 估在底部 + scrollToFn 预写 total height
 * 4. anchorTo/followOnAppend + 贴底时 size change 直接 scrollToEnd
 * 5. unmount takeSnapshot 写回 cache
 * 6. directDomUpdates 滚动写 transform，不触发 React 重渲染
 */
import {
  useRef, useImperativeHandle, forwardRef, memo,
  useCallback, useEffect, useLayoutEffect, useMemo, useState,
} from 'react'
import {
  useVirtualizer, elementScroll, defaultRangeExtractor,
  type VirtualItem,
} from '@tanstack/react-virtual'
import type { Virtualizer as CoreVirtualizer } from '@tanstack/virtual-core'
import { useTranslation } from 'react-i18next'
import {
  MessageRenderer,
  ProcessCollapseBlock,
  assistantHasFinalContent,
  assistantHasProcessContent,
} from '../message'
import { MessageErrorView } from '../message/parts'
import { SpinnerIcon, ArrowDownIcon, ArrowUpIcon, PencilIcon, TrashIcon } from '../../components/Icons'
import { CopyButton } from '../../components/ui'
import { useInputCapabilities } from '../../hooks/useInputCapabilities'
import type { MessageError } from '../../types/message'
import type { PiTimelineItem } from '../../pi/domain/index.js'
import { RetryStatusInline, type RetryStatusInlineData } from './RetryStatusInline'
import { buildVisibleTimelineEntries, getVisibleTimelineForkTargetId } from './chatAreaVisibility'
import { AT_BOTTOM_THRESHOLD_PX } from '../../constants'
import { useChatViewportSelect } from './chatViewport'
import {
  buildProcessTimeline,
  buildTurnDurationMap,
  buildTurnLatestAssistantIdSet,
  reuseProcessTimelineItems,
  type ProcessTimelineItem,
  type StableChatPage,
} from './chatPageModel'
import { useTheme } from '../../hooks/useTheme'
import { getStreamingHotIndexes, getTimelineRowYClass, mergeVirtualRangeIndexes } from './chatAreaUtils'
import { useAutoScroll } from './virtual/useAutoScroll'
import { useEmptyWorkingShellGate } from './virtual/useEmptyWorkingShellGate'
import { perfMark, perfRecordRender, isPerfEnabled } from '../../utils/perf'

const ROW_ESTIMATE = 60
/** 过程壳 header 行高（Working / Worked 一行） */
const PROCESS_SHELL_HEADER = 36
/** 用户入场生长结束后，空 Working 壳再等多久（有 assistant 则立刻挂，不等） */
const EMPTY_WORKING_SHELL_EXTRA_DELAY_MS = 500
const DEFAULT_BOTTOM_SPACER = 256
const SESSION_CACHE_LIMIT = 16

/** 内容等价判断：流式 chunk 只换数组引用时，复用旧 Map/Set 引用，
 *  否则 VirtualRow 的 memo 比较（含这三个引用）会被击穿，历史行跟着重渲染。 */
function sameMap<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false
  }
  return true
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

const bottomSpacerHeight = (bottomPadding: number) =>
  bottomPadding > 0 ? bottomPadding + 48 : DEFAULT_BOTTOM_SPACER

function estimateTimelineItemSize(item: ProcessTimelineItem | undefined): number {
  if (!item) return ROW_ESTIMATE
  if (item.kind === 'message') return ROW_ESTIMATE
  // 进行中默认展开：header + 壳内消息（空回合至少占 header）
  if (item.isActive) {
    const body = Math.max(item.children.length, 1) * ROW_ESTIMATE
    return PROCESS_SHELL_HEADER + body
  }
  // 结束后默认折叠：只估 header + 壳外 final，避免刷新时 120→36 的假高度再回弹
  return PROCESS_SHELL_HEADER + (item.finalItem ? ROW_ESTIMATE : 0)
}

function sessionCacheKey(sessionId: string, processCollapseEnabled: boolean): string {
  return `${sessionId}:${processCollapseEnabled ? 'process' : 'flat'}`
}

// ─── 接口定义（保持不变） ───────────────────────────────────────

interface ChatAreaProps {
  items: PiTimelineItem[]
  queuedSteering?: readonly string[]
  queuedFollowUps?: readonly string[]
  /** 队列消息操作：撤销回输入框 / 切换 steer↔followUp 模式 / 直接清除 */
  onQueueBackToInput?: (kind: 'steering' | 'followUp', index: number) => void | Promise<void>
  onQueueMoveMode?: (kind: 'steering' | 'followUp', index: number) => void | Promise<void>
  onQueueClear?: (kind: 'steering' | 'followUp', index: number) => void | Promise<void>
  pageRecords?: StableChatPage[]
  forkTargetIdMap?: Map<string, string | undefined>
  turnDurationMap?: Map<string, number>
  turnLatestAssistantIds?: Set<string>
  sessionId?: string | null
  isStreaming?: boolean
  /** 上下文压缩进行中：在消息流底部显示行内指示 + 取消（对齐 Pi TUI 的状态条） */
  isCompacting?: boolean
  loadState?: 'idle' | 'loading' | 'loaded' | 'error'
  loadError?: MessageError
  connectionError?: MessageError
  onOpenSettings?: () => void
  hasMoreHistory?: boolean
  onLoadMore?: () => void | Promise<void>
  onUndo?: (entryId: string) => void
  onFork?: (entryId: string, forkMessageId?: string) => void | Promise<void>
  canUndo?: boolean
  registerMessage?: (id: string, element: HTMLElement | null) => void
  retryStatus?: RetryStatusInlineData | null
  bottomPadding?: number
  onVisibleMessageIdsChange?: (ids: string[]) => void
  onAtBottomChange?: (atBottom: boolean) => void
}

export type ChatAreaHandle = {
  scrollToBottom: (instant?: boolean) => void
  scrollToBottomIfAtBottom: () => void
  scrollToLastMessage: () => void
  scrollToMessageIndex: (index: number) => void
  scrollToMessageId: (messageId: string) => void
}

// ─── 虚拟行 ──────────────────────────────────────────────────

interface MessageBodyProps {
  item: PiTimelineItem
  registerMessage?: (id: string, element: HTMLElement | null) => void
  onUndo?: (entryId: string) => void
  onFork?: (entryId: string, forkMessageId?: string) => void | Promise<void>
  canUndo?: boolean
  forkMessageId?: string
  turnDuration?: number
  isTurnLatestAssistant?: boolean
  processContentScope?: 'all' | 'process' | 'final' | 'inline'
  onEntryGrowComplete?: (messageId: string) => void
}

const MessageBody = memo(function MessageBody({
  item,
  registerMessage,
  onUndo,
  onFork,
  canUndo,
  forkMessageId,
  turnDuration,
  isTurnLatestAssistant,
  processContentScope = 'all',
  onEntryGrowComplete,
}: MessageBodyProps) {
  const messageId = item.renderKey ?? item.entryId
  const isUser = item.kind === 'user_message'
  return (
    <div
      ref={node => registerMessage?.(messageId, node as HTMLDivElement | null)}
      data-message-id={messageId}
      data-anchor-source-id={forkMessageId ?? messageId}
    >
      <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
        <div className={`message-renderer-shell min-w-0 group ${!isUser ? 'w-full' : ''}`}>
          <MessageRenderer
            item={item}
            turnDuration={turnDuration}
            isTurnLatestAssistant={isTurnLatestAssistant}
            processContentScope={processContentScope}
            onUndo={isUser ? onUndo : undefined}
            onFork={onFork}
            forkMessageId={forkMessageId}
            canUndo={isUser ? canUndo : undefined}
            onEntryGrowComplete={isUser ? onEntryGrowComplete : undefined}
          />
        </div>
      </div>
    </div>
  )
})

export const QueuedUserMessageQueue = memo(function QueuedUserMessageQueue({
  kind,
  items,
  maxWidthClass,
  paddingClass,
  onBackToInput,
  onMoveMode,
  onClear,
}: {
  kind: 'current' | 'next'
  items: readonly string[]
  maxWidthClass: string
  paddingClass: string
  /** 修改该条（pi 不支持队列内修改：清除后回填输入框，编辑后重发） */
  onBackToInput?: (queueKind: 'steering' | 'followUp', index: number) => void | Promise<void>
  /** 切换该条队列模式（steer ↔ followUp） */
  onMoveMode?: (queueKind: 'steering' | 'followUp', index: number) => void | Promise<void>
  /** 直接清除该条 */
  onClear?: (queueKind: 'steering' | 'followUp', index: number) => void | Promise<void>
}) {
  const { t } = useTranslation('chat')
  const { preferTouchUi } = useInputCapabilities()
  if (items.length === 0) return null

  const queueKind = kind === 'current' ? 'steering' : 'followUp'
  const moveTitle = t(kind === 'current' ? 'chatArea.moveQueueToNext' : 'chatArea.moveQueueToCurrent')
  const label = t(kind === 'current' ? 'chatArea.currentTurnQueue' : 'chatArea.nextTurnQueue', {
    count: items.length,
  })
  // 对齐用户消息 action bar：PC 悬浮显示、触控恒显示
  const actionBarClass = preferTouchUi
    ? 'flex items-center gap-0.5 transition-opacity'
    : 'flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 transition-opacity'
  const actionBtnClass =
    'flex h-6 w-6 items-center justify-center rounded-md text-text-400 hover:text-text-200 hover:bg-bg-200/50 transition-colors'
  return (
    <section
      data-message-queue={kind}
      aria-label={label}
      className={`w-full ${maxWidthClass} mx-auto ${paddingClass} pt-3 pb-2`}
    >
      <div className="flex items-center gap-3 pb-3 text-[length:var(--fs-sm)] text-text-500" role="status">
        <span className="h-px flex-1 bg-border-200" aria-hidden="true" />
        <span className="shrink-0">{label}</span>
        <span className="h-px flex-1 bg-border-200" aria-hidden="true" />
      </div>
      <div className="flex flex-col items-end gap-2">
        {items.map((text, index) => (
          <div
            key={`${index}:${text}`}
            className="group/msg max-w-[85%] rounded-2xl border border-dashed border-border-200 bg-bg-300/60 px-4 py-2.5"
          >
            <div className="whitespace-pre-wrap break-words text-[length:var(--fs-base)] leading-relaxed text-text-200">
              {text}
            </div>
            {(onBackToInput || onMoveMode || onClear) && (
              <div className={`mt-1 ${actionBarClass}`}>
                <CopyButton text={text} position="static" />
                {onClear && (
                  <button
                    type="button"
                    onClick={() => void onClear(queueKind, index)}
                    title={t('chatArea.clearQueueItem')}
                    className={actionBtnClass}
                  >
                    <TrashIcon size={14} />
                  </button>
                )}
                {onMoveMode && (
                  <button
                    type="button"
                    onClick={() => void onMoveMode(queueKind, index)}
                    title={moveTitle}
                    className={actionBtnClass}
                  >
                    {kind === 'current' ? <ArrowDownIcon size={14} /> : <ArrowUpIcon size={14} />}
                  </button>
                )}
                {onBackToInput && (
                  <button
                    type="button"
                    onClick={() => void onBackToInput(queueKind, index)}
                    title={t('chatArea.editQueueItem')}
                    className={actionBtnClass}
                  >
                    <PencilIcon size={14} />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
})

interface RowProps {
  virtualItem: VirtualItem
  item: ProcessTimelineItem
  maxWidthClass: string
  paddingClass: string
  rowYClass: string
  registerMessage?: (id: string, element: HTMLElement | null) => void
  onUndo?: (entryId: string) => void
  onFork?: (entryId: string, forkMessageId?: string) => void | Promise<void>
  canUndo?: boolean
  forkMap: Map<string, string | undefined>
  turnDurationMap: Map<string, number>
  turnLatestAssistantIds: Set<string>
  measureElement: (el: HTMLElement | null) => void
  onEntryGrowComplete?: (messageId: string) => void
}

const VirtualRow = memo(function VirtualRow({
  virtualItem,
  item,
  maxWidthClass,
  paddingClass,
  rowYClass,
  registerMessage,
  onUndo,
  onFork,
  canUndo,
  forkMap,
  turnDurationMap,
  turnLatestAssistantIds,
  measureElement,
  onEntryGrowComplete,
}: RowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null)
  if (isPerfEnabled()) perfRecordRender('VirtualRow', 0)

  const setRef = useCallback((el: HTMLDivElement | null) => {
    rowRef.current = el
    perfMark('piui:measure-row')
    measureElement(el)
    perfMark('piui:measure-row:end')
  }, [measureElement])

  useLayoutEffect(() => {
    // item 引用变化（打断/折叠/错误条出现，A 步保证只有变化行变）时
    // 重新测量：virtual-core 的 measureElement 在测量高度与缓存一致
    // （delta === 0）时不 notify，行会残留旧 transform 与相邻行重叠。
    // 这里在内容变化后强制重测，让后续行位置按最新高度重算。
    if (rowRef.current) measureElement(rowRef.current)
  }, [measureElement, virtualItem.index, item.key, rowYClass, item])

  return (
    <div
      ref={setRef}
      data-timeline-key={item.key}
      data-index={virtualItem.index}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%' }}
    >
      <div className={`w-full ${maxWidthClass} mx-auto ${paddingClass} ${rowYClass} transition-[max-width] duration-300 ease-in-out`}>
        {item.kind === 'message' ? (
          <MessageBody
            item={item.item}
            registerMessage={registerMessage}
            onUndo={onUndo}
            onFork={onFork}
            canUndo={canUndo}
            forkMessageId={forkMap.get(item.item.entryId)}
            turnDuration={turnDurationMap.get(item.item.entryId)}
            isTurnLatestAssistant={
              item.item.kind === 'assistant_message'
                ? turnLatestAssistantIds.has(item.item.entryId)
                : undefined
            }
            processContentScope={item.processContentScope ?? 'all'}
            onEntryGrowComplete={onEntryGrowComplete}
          />
        ) : (
          <div className="flex justify-start">
            <div className="message-renderer-shell min-w-0 group w-full flex flex-col gap-2">
              <ProcessCollapseBlock
                stateKey={`turn-process:${item.userMessageId ?? item.key}`}
                startedAt={item.startedAt}
                durationMs={item.durationMs}
                isActive={item.isActive}
              >
                {item.children.map(child => (
                  <MessageBody
                    key={`${child.item.entryId}:${child.processContentScope}`}
                    item={child.item}
                    registerMessage={registerMessage}
                    onUndo={onUndo}
                    onFork={onFork}
                    canUndo={canUndo}
                    forkMessageId={forkMap.get(child.item.entryId)}
                    turnDuration={turnDurationMap.get(child.item.entryId)}
                    isTurnLatestAssistant={turnLatestAssistantIds.has(child.item.entryId)}
                    processContentScope={child.processContentScope}
                  />
                ))}
              </ProcessCollapseBlock>
              {/* shell 的 gap-2 只服务 process 壳 ↔ final 文本，子消息间距由 processBody 管 */}
              {item.finalItem && (
                <MessageBody
                  item={item.finalItem}
                  registerMessage={registerMessage}
                  onUndo={onUndo}
                  onFork={onFork}
                  canUndo={canUndo}
                  forkMessageId={forkMap.get(item.finalItem.entryId)}
                  turnDuration={turnDurationMap.get(item.finalItem.entryId)}
                  isTurnLatestAssistant
                  processContentScope="final"
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}, (prev, next) =>
  prev.virtualItem.index === next.virtualItem.index &&
  prev.virtualItem.start === next.virtualItem.start &&
  prev.virtualItem.size === next.virtualItem.size &&
  prev.item === next.item &&
  prev.maxWidthClass === next.maxWidthClass &&
  prev.paddingClass === next.paddingClass &&
  prev.rowYClass === next.rowYClass &&
  prev.registerMessage === next.registerMessage &&
  prev.onUndo === next.onUndo &&
  prev.onFork === next.onFork &&
  prev.canUndo === next.canUndo &&
  prev.forkMap === next.forkMap &&
  prev.turnDurationMap === next.turnDurationMap &&
  prev.turnLatestAssistantIds === next.turnLatestAssistantIds &&
  prev.measureElement === next.measureElement &&
  prev.onEntryGrowComplete === next.onEntryGrowComplete
)

// ─── 会话缓存（LRU 16） ───────────────────────────────────────

const sessionCache = new Map<string, { measurements: VirtualItem[] }>()

// ─── ChatArea ────────────────────────────────────────────────

export const ChatArea = memo(
  forwardRef<ChatAreaHandle, ChatAreaProps>(
    (
      {
        items, queuedSteering = [], queuedFollowUps = [],
        onQueueBackToInput, onQueueMoveMode, onQueueClear,
        forkTargetIdMap: forkTargetIdMapProp, turnDurationMap: turnDurationMapProp,
        turnLatestAssistantIds: turnLatestAssistantIdsProp,
        sessionId, isStreaming = false, isCompacting = false,
        loadState = 'idle', loadError, connectionError, onOpenSettings,
        hasMoreHistory = false, onLoadMore, onUndo, onFork, canUndo,
        registerMessage, retryStatus = null, bottomPadding = 0,
        onVisibleMessageIdsChange, onAtBottomChange,
      },
      ref,
    ) => {
      const renderStart = isPerfEnabled() ? performance.now() : 0
      const { t } = useTranslation('chat')
      const { isWideMode, processCollapseEnabled } = useTheme()
      // 只订阅离散的 isCompact：宽度连续变化时该值不变，ChatArea 不重渲染
      // （对齐 reference 选择器订阅：宽度变化只剩浏览器原生 reflow，无 React 全树重渲染）
      const isCompact = useChatViewportSelect(value => value.presentation.isCompact)
      const atBottomThreshold = isCompact ? 150 : AT_BOTTOM_THRESHOLD_PX
      const paddingClass = isCompact ? 'px-3' : 'px-5'
      const maxWidthClass = isWideMode ? 'max-w-[95%] xl:max-w-6xl' : 'max-w-2xl'

      // ── 派生数据 ──
      const entries = useMemo(() => buildVisibleTimelineEntries(items), [items])
      const visibleItems = useMemo(() => entries.map(e => e.item), [entries])
      const forkMapRef = useRef<Map<string, string | undefined> | null>(null)
      const forkMap = useMemo(() => {
        const next = forkTargetIdMapProp
          ?? new Map(entries.map(e => [e.item.entryId, getVisibleTimelineForkTargetId(e)]))
        const prev = forkMapRef.current
        if (prev && sameMap(prev, next)) return prev
        forkMapRef.current = next
        return next
      }, [forkTargetIdMapProp, entries])
      // 流式期间 items 数组每个 chunk 都是新引用，但这些 map/set 的内容只在
      // 回合完成/结构变化时才会变（live 行 streaming 无 duration、entryId 稳定）。
      // 内容等价时复用旧引用，否则每次 token 都会新建 Map/Set，把 VirtualRow
      // 的 memo 比较（含这三个引用）全部击穿 → 历史行跟着 live 行一起重渲染。
      const turnDurationMapRef = useRef<Map<string, number> | null>(null)
      const turnDurationMap = useMemo(() => {
        const next = turnDurationMapProp ?? buildTurnDurationMap(items, visibleItems)
        const prev = turnDurationMapRef.current
        if (prev && sameMap(prev, next)) return prev
        turnDurationMapRef.current = next
        return next
      }, [items, turnDurationMapProp, visibleItems])
      const turnLatestIdsRef = useRef<Set<string> | null>(null)
      const turnLatestAssistantIds = useMemo(() => {
        const next = turnLatestAssistantIdsProp ?? buildTurnLatestAssistantIdSet(visibleItems)
        const prev = turnLatestIdsRef.current
        if (prev && sameSet(prev, next)) return prev
        turnLatestIdsRef.current = next
        return next
      }, [turnLatestAssistantIdsProp, visibleItems])

      // 空 Working 壳闸门：入场完成 + 额外停顿；idle 清空；有 assistant 立刻挂
      const emptyShellGate = useEmptyWorkingShellGate(isStreaming, EMPTY_WORKING_SHELL_EXTRA_DELAY_MS)

      // 过程折叠：按 user 回合建时间线；关闭时退回「一行一条消息」
      // previous 用于 item 级 structural sharing：流式只脏热行，VirtualRow memo 才能命中
      // 折叠开关切换时不跨模式复用（flat 与 process-shell 的 key 语义不同）
      const previousTimelineRef = useRef<{
        processCollapseEnabled: boolean
        items?: ProcessTimelineItem[]
      }>({ processCollapseEnabled })
      const timeline = useMemo<ProcessTimelineItem[]>(() => {
        perfMark('piui:build-timeline')
        const next = !processCollapseEnabled
          ? visibleItems.map(item => ({
              kind: 'message' as const,
              key: item.renderKey ?? item.entryId,
              item,
            }))
          : buildProcessTimeline(visibleItems, {
              turnDurationMap,
              sessionIsStreaming: isStreaming,
              messageHasProcess: assistantHasProcessContent,
              messageHasFinal: assistantHasFinalContent,
              isUserEntryReady: emptyShellGate.isReady,
            })
        const previous =
          previousTimelineRef.current.processCollapseEnabled === processCollapseEnabled
            ? previousTimelineRef.current.items
            : undefined
        const reused = reuseProcessTimelineItems(previous, next)
        previousTimelineRef.current = { processCollapseEnabled, items: reused }
        perfMark('piui:build-timeline:end')
        return reused
        // emptyShellGate.version：额外延迟到期后强制重算，挂上 Working 壳
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [processCollapseEnabled, visibleItems, turnDurationMap, isStreaming, emptyShellGate.version, emptyShellGate.isReady])

      const messageIdToTimelineIndex = useMemo(() => {
        const map = new Map<string, number>()
        timeline.forEach((item, index) => {
          if (item.kind === 'message') {
            map.set(item.item.entryId, index)
            if (item.item.renderKey) map.set(item.item.renderKey, index)
            return
          }
          if (item.userMessageId) map.set(item.userMessageId, index)
          for (const child of item.children) {
            map.set(child.item.entryId, index)
            if (child.item.renderKey) map.set(child.item.renderKey, index)
          }
          if (item.finalItem) {
            map.set(item.finalItem.entryId, index)
            if (item.finalItem.renderKey) map.set(item.finalItem.renderKey, index)
          }
        })
        return map
      }, [timeline])

      // ── Refs（避免闭包过期） ──
      const scrollRef = useRef<HTMLDivElement | null>(null)
      const contentRef = useRef<HTMLDivElement | null>(null)
      const sessionIdRef = useRef(sessionId); sessionIdRef.current = sessionId
      const onLoadMoreRef = useRef(onLoadMore); onLoadMoreRef.current = onLoadMore
      const onVisibleIdsRef = useRef(onVisibleMessageIdsChange); onVisibleIdsRef.current = onVisibleMessageIdsChange
      const onAtBottomRef = useRef(onAtBottomChange); onAtBottomRef.current = onAtBottomChange
      const hasMoreRef = useRef(hasMoreHistory); hasMoreRef.current = hasMoreHistory
      const loadStateRef = useRef(loadState); loadStateRef.current = loadState
      const thresholdRef = useRef(atBottomThreshold); thresholdRef.current = atBottomThreshold

      const [isLoadingMore, setIsLoadingMore] = useState(false)
      const loadingMoreRef = useRef(false)

      // ── 自动滚动 ──
      // userScrolled 判定用小阈值（10px），和 UI 回底按钮的 60/150 阈值分开。
      // 否则上滚一点点仍在“底部区”里，userScrolled 会被立刻清掉，
      // 再碰上最后一条 HTML 时钟每秒重测 → scrollToEnd，怎么滚都拉回底。
      const auto = useAutoScroll(10)
      const autoSetScrollRef = auto.setScrollRef
      const autoSetContentRef = auto.setContentRef
      const autoHandleScroll = auto.handleScroll
      const autoHandleWheel = auto.handleWheel
      const autoHandleInteraction = auto.handleInteraction
      const autoForceScroll = auto.forceScrollToBottom
      const autoScrollBottom = auto.scrollToBottom
      const autoPause = auto.pause
      const autoMarkAuto = auto.markAuto
      const userScrolledRef = auto.userScrolledRef
      const spacerHeight = bottomSpacerHeight(bottomPadding)
      // 贴底判断必须读 ref：wheel→stop 后 state 还没 re-render，
      // 若仍用 state，同一帧的 ResizeObserver 会误判仍可贴底。
      const shouldAnchorBottom = useCallback(() => !userScrolledRef.current, [userScrolledRef])

      // ── 滚动状态（同步计算，不使用 rAF） ──
      // prevState.bottom 仍是几何贴底，给 scrollToBottomIfAtBottom 用。
      // onAtBottomChange 给输入区 dock / 回底按钮：只反映 !userScrolled（用户意图），
      // 不跟 dist——流式长高那一帧 dist 会越过阈值，会把 isCollapsed 抖翻。
      const prevState = useRef({ overflow: false, bottom: true, jump: false })
      const computeScrollState = useCallback(() => {
        const el = scrollRef.current
        if (!el) return
        const max = el.scrollHeight - el.clientHeight
        const dist = max - el.scrollTop
        const overflow = max > 1
        const bottom = !overflow || dist <= thresholdRef.current
        const jump = overflow && dist > Math.max(400, el.clientHeight)
        const p = prevState.current
        if (p.overflow !== overflow || p.bottom !== bottom || p.jump !== jump) {
          prevState.current = { overflow, bottom, jump }
        }
      }, [])

      // 输入区折叠 / 回底按钮：只跟用户是否主动离底
      useEffect(() => {
        onAtBottomRef.current?.(!auto.userScrolled)
      }, [auto.userScrolled])

      // ── Virtualizer ──
      // parent key={sessionId} remount 后，这里只在 mount 时读一次 cache
      // cache key 必须带过程折叠模式：flat 与 process 的 item key/高度完全不同
      const cacheKey = sessionId ? sessionCacheKey(sessionId, processCollapseEnabled) : null
      const initialCacheRef = useRef(cacheKey ? sessionCache.get(cacheKey)?.measurements : undefined)
      const coldBottomMount = !initialCacheRef.current?.length
      const [renderOverscan, setRenderOverscan] = useState(
        initialCacheRef.current?.length || coldBottomMount ? 6 : 15,
      )
      const resizePinnedRef = useRef<number[]>([])
      const resizePinFrame = useRef<number | undefined>(undefined)
      const resizeAnchorScheduled = useRef(false)
      /** 流式热行 pin：ref 更新，不碰贴底/SSE 路径 */
      const hotPinnedRef = useRef<number[]>([])
      hotPinnedRef.current = getStreamingHotIndexes(timeline.length, isStreaming)

      // 冷启动估在底部：有 cache 用 cache 总高，否则 estimate*count + paddingEnd。
      // 不用 MAX_SAFE_INTEGER（单列 range 不会向前扩，只会渲染最后一项）。
      const estimatedBottomOffset = useMemo(() => {
        const cached = initialCacheRef.current
        if (cached?.length) {
          const last = cached[cached.length - 1]
          return Math.max(0, (last?.end ?? 0) + spacerHeight - 600)
        }
        const estimatedTotal = timeline.reduce((sum, item) => sum + estimateTimelineItemSize(item), 0)
        return Math.max(0, estimatedTotal + spacerHeight - 600)
        // 只在 mount 用初始 count 估一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: timeline.length,
        getScrollElement: () => scrollRef.current,
        initialOffset: estimatedBottomOffset,
        initialMeasurementsCache: initialCacheRef.current,
        estimateSize: (index) => estimateTimelineItemSize(timeline[index]),
        getItemKey: (i) => timeline[i]?.key ?? `removed:${i}`,
        // 输入框占位放在消息区外（retry/error 之后），避免重试提示被压到输入框下面
        paddingEnd: 0,
        scrollEndThreshold: 80,
        // 预写 total height，避免浏览器把新 offset clamp 到旧高度（oc 同款）
        scrollToFn: (offset, options, instance) => {
          if (contentRef.current) contentRef.current.style.height = `${instance.getTotalSize()}px`
          autoMarkAuto(scrollRef.current)
          elementScroll(offset, options, instance)
        },
        anchorTo: 'end',
        followOnAppend: false,
        overscan: 50,
        directDomUpdates: true,
        directDomUpdatesMode: 'transform',
        rangeExtractor: (range) => {
          const indexes = defaultRangeExtractor({ ...range, overscan: renderOverscan })
          return mergeVirtualRangeIndexes(indexes, resizePinnedRef.current, hotPinnedRef.current)
        },
      })

      // 一次性 overrides（resizeItem + shouldAdjust）——对齐 oc
      const overridesApplied = useRef(false)
      if (!overridesApplied.current) {
        // virtual-core 未在公开类型中暴露的内部字段，按需声明（仅此块内使用）
        type VirtualizerInternals = {
          measurementsCache: (VirtualItem | undefined)[]
          itemSizeCache: Map<VirtualItem['key'], number>
          options: { anchorTo?: 'start' | 'end' }
          getScrollOffset?: () => number
          scrollAdjustments?: number
          isAtEnd?: (offset?: number) => boolean
        }
        const vInternals = virtualizer as unknown as VirtualizerInternals
        const origResize = virtualizer.resizeItem
        virtualizer.resizeItem = (index: number, size: number) => {
          const item = vInternals.measurementsCache[index]
          const prev = item ? (vInternals.itemSizeCache.get(item.key) ?? item.size) : undefined
          const root = scrollRef.current
          if (root && prev !== undefined && Math.abs(size - prev) > root.clientHeight) {
            const view = root.getBoundingClientRect()
            resizePinnedRef.current = [...root.querySelectorAll<HTMLElement>('[data-index]')]
              .filter(el => {
                const r = el.getBoundingClientRect()
                return r.bottom > view.top && r.top < view.bottom
              })
              .map(el => Number(el.dataset.index))
            if (resizePinFrame.current !== undefined) cancelAnimationFrame(resizePinFrame.current)
            resizePinFrame.current = requestAnimationFrame(() => {
              resizePinFrame.current = requestAnimationFrame(() => {
                resizePinFrame.current = undefined
                resizePinnedRef.current = []
              })
            })
          }
          // 核心修复：用户已上滚（userScrolledRef）时，临时关掉 anchorTo:'end'，
          // 阻止 virtual-core resizeItem 内部的 wasAtEnd 路径（applyScrollAdjustment 拉回）。
          // wasAtEnd 用 getVirtualDistanceFromEnd()（基于内部 scrollOffset），
          // 但 React commit 阶段 ref 回调触发 measureElement 时 scroll 事件还没 fire，
          // scrollOffset 是陈旧的（仍指向底部），wasAtEnd 误判为 true → 拉回。
          // userScrolledRef 由 handleWheel 上滚设 true，只由 handleWheel 下滚回底设 false，
          // handleScroll 不清它（避免流式增长推回时误清）。
          if (userScrolledRef.current) {
            const opts = vInternals.options
            const origAnchor = opts.anchorTo
            opts.anchorTo = 'start'
            origResize(index, size)
            opts.anchorTo = origAnchor
          } else {
            origResize(index, size)
          }
          if (
            root
            && shouldAnchorBottom()
            && !resizeAnchorScheduled.current
            && vInternals.isAtEnd?.(80)
          ) {
            resizeAnchorScheduled.current = true
            queueMicrotask(() => {
              resizeAnchorScheduled.current = false
              if (!shouldAnchorBottom()) return
              if (!vInternals.isAtEnd?.(80)) return
              const el = scrollRef.current
              if (!el) return
              autoMarkAuto(el)
              const max = Math.max(0, el.scrollHeight - el.clientHeight)
              if (max - el.scrollTop >= 2) el.scrollTop = max
            })
          }
        }
        virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
          item: VirtualItem,
          _delta: number,
          instance: CoreVirtualizer<HTMLDivElement, HTMLDivElement>,
        ) => {
          if (shouldAnchorBottom()) return false
          const v = instance as unknown as VirtualizerInternals
          return item.end <= (v.getScrollOffset?.() ?? 0) + (v.scrollAdjustments ?? 0)
        }
        overridesApplied.current = true
      }

      // ── 历史加载（prepend 锚点） ──
      const prependAnchor = useRef<{ key: string; offset: number } | undefined>(undefined)
      const prependFrame = useRef<number | undefined>(undefined)
      const prependLoading = useRef(false)

      const clearPrepend = useCallback(() => {
        prependLoading.current = false
        prependAnchor.current = undefined
        if (prependFrame.current !== undefined) { cancelAnimationFrame(prependFrame.current); prependFrame.current = undefined }
      }, [])

      const updatePrependAnchor = useCallback(() => {
        const root = scrollRef.current
        if (!root) return
        const view = root.getBoundingClientRect()
        const anchor = [...root.querySelectorAll<HTMLElement>('[data-timeline-key]')]
          .map(el => ({ el, rect: el.getBoundingClientRect() }))
          .filter(x => x.rect.bottom > view.top && x.rect.top < view.bottom)
          .sort((a, b) => a.rect.top - b.rect.top)[0]
        if (anchor?.el.dataset.timelineKey) {
          prependAnchor.current = { key: anchor.el.dataset.timelineKey, offset: anchor.rect.top - view.top }
        }
      }, [])

      const applyPrependAnchor = useCallback(() => {
        const root = scrollRef.current
        if (!root || !prependAnchor.current) return
        if (prependFrame.current !== undefined) cancelAnimationFrame(prependFrame.current)
        let frames = 0, stable = 0
        const apply = () => {
          prependFrame.current = undefined
          const a = prependAnchor.current
          if (!a) return
          const el = root.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(a.key)}"]`)
          const delta = el ? el.getBoundingClientRect().top - root.getBoundingClientRect().top - a.offset : undefined
          if (delta !== undefined && Math.abs(delta) > 0.5) { root.scrollTop += delta; stable = 0 }
          else stable++
          if (++frames >= 180 || stable >= 30) { if (!prependLoading.current) prependAnchor.current = undefined; return }
          prependFrame.current = requestAnimationFrame(apply)
        }
        prependFrame.current = requestAnimationFrame(apply)
      }, [])

      const capturePrepend = useCallback(() => {
        prependLoading.current = true
        updatePrependAnchor()
      }, [updatePrependAnchor])

      const restorePrepend = useCallback((done: boolean) => {
        if (done) prependLoading.current = false
        applyPrependAnchor()
      }, [applyPrependAnchor])

      const loadMore = useCallback(() => {
        capturePrepend()
        setIsLoadingMore(true); loadingMoreRef.current = true
        Promise.resolve()
          .then(() => onLoadMoreRef.current?.())
          .catch(() => {})
          .finally(() => {
            setIsLoadingMore(false); loadingMoreRef.current = false
            restorePrepend(true)
          })
      }, [capturePrepend, restorePrepend])

      // fill: 内容不足以填满视口时自动加载
      const fillFrame = useRef<number | undefined>(undefined)
      const fill = useCallback(() => {
        if (fillFrame.current !== undefined) return
        fillFrame.current = requestAnimationFrame(() => {
          fillFrame.current = undefined
          if (!sessionIdRef.current || loadStateRef.current !== 'loaded') return
          if (userScrolledRef.current || loadingMoreRef.current) return
          const el = scrollRef.current
          if (el && el.scrollHeight > el.clientHeight + 1) return
          if (!hasMoreRef.current) return
          void loadMore()
        })
      }, [loadMore, userScrolledRef])

      // ── Ref 回调 ──
      const setScrollRoot = useCallback((el: HTMLDivElement | null) => {
        scrollRef.current = el
        autoSetScrollRef(el)
        if (el) { computeScrollState(); fill() }
      }, [autoSetScrollRef, computeScrollState, fill])

      const setVirtualContent = useCallback((el: HTMLDivElement | null) => {
        contentRef.current = el
        autoSetContentRef(el)
        virtualizer.containerRef(el)
        if (el && scrollRef.current) computeScrollState()
      }, [autoSetContentRef, virtualizer, computeScrollState])

      const pinToBottom = useCallback(() => {
        // 必须滚到整页底（含 retry/error + 输入框 spacer），不能只 scrollToEnd 虚拟消息区
        const el = scrollRef.current
        if (!el) return
        autoMarkAuto(el)
        const max = Math.max(0, el.scrollHeight - el.clientHeight)
        if (max - el.scrollTop >= 2) el.scrollTop = max
      }, [autoMarkAuto])

      // ── 事件处理 ──
      const onScroll = useCallback(() => {
        if (prependLoading.current) updatePrependAnchor()
        computeScrollState()
        if (
          userScrolledRef.current
          && (scrollRef.current?.scrollTop ?? 0) < 200
          && !loadingMoreRef.current
          && hasMoreRef.current
        ) {
          void loadMore()
        }
        // 始终走 handleScroll：滚动条/键盘也能离底；程序贴底靠 markAuto 过滤
        autoHandleScroll()
      }, [updatePrependAnchor, computeScrollState, autoHandleScroll, loadMore, userScrolledRef])

      const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
        if (!prependLoading.current) clearPrepend()
        autoHandleWheel(e.nativeEvent)
      }, [autoHandleWheel, clearPrepend])

      const onTouchStart = useCallback(() => {
        if (!prependLoading.current) clearPrepend()
      }, [clearPrepend])

      // ── Effects（parent key remount 后，这里只处理本实例生命周期） ──

      // 冷启动 / 回流：双 rAF 贴底 + 抬 overscan（对齐 oc onMount）
      useEffect(() => {
        let cancelled = false
        let outer = 0
        let inner = 0
        outer = requestAnimationFrame(() => {
          if (cancelled) return
          if (shouldAnchorBottom()) pinToBottom()
          inner = requestAnimationFrame(() => {
            if (cancelled) return
            if (renderOverscan < 15) setRenderOverscan(15)
            if (shouldAnchorBottom()) pinToBottom()
          })
        })
        return () => {
          cancelled = true
          cancelAnimationFrame(outer)
          cancelAnimationFrame(inner)
        }
        // mount-only
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // rows 变化且应贴底时再确认一次（append / 首批消息）
      // prepend 由 anchorTo + prepend 锚点处理，这里在用户已离底时不跟
      const timelineStructureKey = useMemo(
        () => timeline.map(item => {
          if (item.kind === 'message') return `message:${item.key}`
          return `shell:${item.key}:${item.isActive ? 'active' : 'settled'}:${item.children.length}:${item.finalItem?.entryId ?? ''}`
        }).join('\u0000'),
        [timeline],
      )
      useLayoutEffect(() => {
        if (timeline.length === 0) return
        if (!shouldAnchorBottom() || prependLoading.current) return
        pinToBottom()
        const frame = requestAnimationFrame(() => {
          if (shouldAnchorBottom()) pinToBottom()
        })
        return () => cancelAnimationFrame(frame)
      }, [timeline.length, timelineStructureKey, pinToBottom, shouldAnchorBottom])

      // retry/error 出现消失、输入框高度变 → 底部 footer 高度变，贴底时要跟着滚
      // 否则重试条进出后 scrollTop 停在旧位置，看起来没贴底
      const footerPinKey = `${retryStatus ? 'r' : ''}|${loadError || connectionError ? 'e' : ''}|${queuedSteering.join('\u0000')}|${queuedFollowUps.join('\u0000')}|${spacerHeight}`
      useLayoutEffect(() => {
        if (!shouldAnchorBottom() || prependLoading.current) return
        pinToBottom()
        // 展开重试详情等会在下一帧才量完高度
        const frame = requestAnimationFrame(() => {
          if (shouldAnchorBottom()) pinToBottom()
        })
        return () => cancelAnimationFrame(frame)
      }, [footerPinKey, pinToBottom, shouldAnchorBottom])

      // 用户返回底部时重新贴底
      const userScrolledInit = useRef(false)
      useEffect(() => {
        if (!userScrolledInit.current) {
          userScrolledInit.current = true
          return
        }
        if (auto.userScrolled) return
        const frame = requestAnimationFrame(() => {
          autoScrollBottom()
          pinToBottom()
        })
        return () => cancelAnimationFrame(frame)
      }, [auto.userScrolled, autoScrollBottom, pinToBottom])

      // fill effect
      useEffect(() => {
        if (!sessionId || loadState !== 'loaded' || isLoadingMore || auto.userScrolled || !hasMoreHistory) return
        fill()
      }, [sessionId, loadState, isLoadingMore, auto.userScrolled, hasMoreHistory, fill])

      // unmount：snapshot 写回 cache（对齐 oc onCleanup）
      useLayoutEffect(() => {
        const key = cacheKey
        return () => {
          if (fillFrame.current !== undefined) cancelAnimationFrame(fillFrame.current)
          if (resizePinFrame.current !== undefined) cancelAnimationFrame(resizePinFrame.current)
          clearPrepend()
          if (!key) return
          sessionCache.delete(key)
          sessionCache.set(key, { measurements: virtualizer.takeSnapshot() })
          while (sessionCache.size > SESSION_CACHE_LIMIT) {
            sessionCache.delete(sessionCache.keys().next().value!)
          }
        }
      }, [cacheKey, virtualizer, clearPrepend])

      // ── 渲染数据 ──
      const virtualItems = virtualizer.getVirtualItems()

      // ── Outline 当前区块：视口锚定的用户消息 ──
      // 不依赖 IntersectionObserver（虚拟行挂载/滚动/流式重建会丢可见集），
      // 直接按 scroll 位置 → 视口顶部的行 → 它所属的上一条用户消息。
      // 助手长文占满视口时也能正确高亮当前区块。
      const currentSectionRef = useRef<string | null>(null)
      const updateVisibleSection = useCallback(() => {
        const root = scrollRef.current
        if (!root) return
        const scrollTop = root.scrollTop
        const rows = virtualizer.getVirtualItems()
        // 视口顶部对应的行：start <= scrollTop 的最后一行（内容坐标）
        let targetIndex = 0
        for (const row of rows) {
          if (row.start <= scrollTop) targetIndex = row.index
          else break
        }
        const row = timeline[targetIndex]
        if (!row) return
        let sectionId: string | null = null
        if (row.kind === 'process-shell') {
          sectionId = row.userMessageId
        } else if (row.item.kind === 'user_message') {
          sectionId = row.item.renderKey ?? row.item.entryId
        } else {
          // assistant/bash/工具行 → 往上找最近的上一条用户消息
          for (let i = targetIndex - 1; i >= 0; i--) {
            const r = timeline[i]
            if (r.kind === 'process-shell' && r.userMessageId) {
              sectionId = r.userMessageId
              break
            }
            if (r.kind === 'message' && r.item.kind === 'user_message') {
              sectionId = r.item.renderKey ?? r.item.entryId
              break
            }
          }
        }
        if (sectionId && sectionId !== currentSectionRef.current) {
          currentSectionRef.current = sectionId
          onVisibleIdsRef.current?.([sectionId])
        }
      }, [timeline, virtualizer])

      // scroll 驱动（rAF 节流：一帧内只算一次）
      useEffect(() => {
        const root = scrollRef.current
        if (!root) return
        let raf = 0
        const onScroll = () => {
          if (raf) return
          raf = requestAnimationFrame(() => {
            raf = 0
            updateVisibleSection()
          })
        }
        root.addEventListener('scroll', onScroll, { passive: true })
        return () => {
          root.removeEventListener('scroll', onScroll)
          if (raf) cancelAnimationFrame(raf)
        }
      }, [updateVisibleSection])

      // timeline/流式变化时重算（scroll 位置没变但行内容/位置变了）
      useEffect(() => {
        updateVisibleSection()
      }, [updateVisibleSection, timeline])

      // ── 命令式接口 ──
      useImperativeHandle(ref, () => ({
        scrollToBottom: () => {
          autoForceScroll()
          pinToBottom()
        },
        scrollToBottomIfAtBottom: () => {
          // userScrolled 守卫：用户上滚后 userScrolled=true，此函数由 onScrollRequest
          //（每个 SSE chunk）调用。autoForceScroll() 的 force=true 会清掉 userScrolled，
          // 导致 resizeItem 的 anchorTo toggle 失效 → wasAtEnd 恢复拉回。
          // 不在此处清 userScrolled——用户主动下滚回底时 handleWheel 会清。
          // 正常贴底跟随（userScrolled=false 时）不受影响。
          if (userScrolledRef.current) return
          if (!prevState.current.bottom) return
          autoForceScroll()
          pinToBottom()
        },
        scrollToLastMessage: () => {
          if (timeline.length === 0) return
          autoMarkAuto(scrollRef.current)
          virtualizer.scrollToIndex(timeline.length - 1, { align: 'end' })
        },
        scrollToMessageIndex: (index: number) => {
          // index 仍按 visibleItems 语义；过程折叠时映射到 timeline 行
          if (index < 0 || index >= visibleItems.length) return
          const messageId = visibleItems[index]?.entryId
          const timelineIndex = messageId != null
            ? (messageIdToTimelineIndex.get(messageId) ?? index)
            : index
          if (timelineIndex < 0 || timelineIndex >= timeline.length) return
          autoPause()
          virtualizer.scrollToIndex(timelineIndex, { align: 'center' })
        },
        scrollToMessageId: (messageId: string) => {
          const timelineIndex = messageIdToTimelineIndex.get(messageId)
          if (timelineIndex == null) return
          autoPause()
          virtualizer.scrollToIndex(timelineIndex, { align: 'center' })
        },
      }), [autoForceScroll, autoPause, autoMarkAuto, pinToBottom, userScrolledRef, virtualizer, timeline, visibleItems, messageIdToTimelineIndex])

      if (isPerfEnabled()) {
        perfRecordRender('ChatArea', performance.now() - renderStart)
      }

      return (
        <div className="h-full overflow-hidden contain-strict relative">
          {loadState === 'loading' && visibleItems.length === 0 && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-text-400 session-loading-indicator">
                <span className="w-5 h-5 border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin" />
                <span className="text-[length:var(--fs-base)]">{t('chatArea.loadingSession')}</span>
              </div>
            </div>
          )}

          <div
            ref={setScrollRoot}
            data-chat-scroll-root="true"
            className="h-full overflow-y-auto overflow-x-hidden custom-scrollbar contain-content"
            style={{
              overflowAnchor: 'none',
              paddingTop: 'calc(5rem + var(--app-safe-top, 0px))',
            }}
            onWheel={onWheel}
            onTouchStart={onTouchStart}
            onScroll={onScroll}
            onClick={autoHandleInteraction}
          >
            {visibleItems.length > 0 && isLoadingMore && (
              <div className="flex justify-center py-3" aria-live="polite">
                <div className="flex items-center gap-2 text-text-400 text-[length:var(--fs-sm)]">
                  <span className="w-3.5 h-3.5 border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin" />
                  {t('chatArea.loadingHistory')}
                </div>
              </div>
            )}

            <div ref={setVirtualContent} style={{ position: 'relative', width: '100%' }}>
              {virtualItems.map(virtualItem => {
                const timelineItem = timeline[virtualItem.index]
                if (!timelineItem) return null
                return (
                  <VirtualRow
                    key={virtualItem.key}
                    virtualItem={virtualItem}
                    item={timelineItem}
                    maxWidthClass={maxWidthClass}
                    paddingClass={paddingClass}
                    rowYClass={getTimelineRowYClass(
                      timelineItem,
                      timeline[virtualItem.index - 1],
                      timeline[virtualItem.index + 1],
                    )}
                    registerMessage={registerMessage}
                    onUndo={onUndo}
                    onFork={onFork}
                    canUndo={canUndo}
                    forkMap={forkMap}
                    turnDurationMap={turnDurationMap}
                    turnLatestAssistantIds={turnLatestAssistantIds}
                    measureElement={virtualizer.measureElement as (el: HTMLElement | null) => void}
                    onEntryGrowComplete={emptyShellGate.onEntryGrowComplete}
                  />
                )
              })}
            </div>

            <QueuedUserMessageQueue
              kind="current"
              items={queuedSteering}
              maxWidthClass={maxWidthClass}
              paddingClass={paddingClass}
              onBackToInput={onQueueBackToInput}
              onMoveMode={onQueueMoveMode}
              onClear={onQueueClear}
            />
            <QueuedUserMessageQueue
              kind="next"
              items={queuedFollowUps}
              maxWidthClass={maxWidthClass}
              paddingClass={paddingClass}
              onBackToInput={onQueueBackToInput}
              onMoveMode={onQueueMoveMode}
              onClear={onQueueClear}
            />

            {/* 顺序必须是：消息 → 下一轮队列 → 重试/错误提示 → 输入框占位。
                旧 Virtuoso Footer 就是这样；换 virtualizer 后 paddingEnd 在前、提示在后，会叠到输入框下。 */}
            {retryStatus && (
              <div className={`w-full ${maxWidthClass} mx-auto ${paddingClass}`}>
                <div className="flex justify-start">
                  <div className="w-full min-w-0">
                    <RetryStatusInline status={retryStatus} />
                  </div>
                </div>
              </div>
            )}

            {visibleItems.length === 0 && (loadError || connectionError) && (
              <div className={`w-full ${maxWidthClass} mx-auto ${paddingClass}`}>
                <div className="flex justify-start">
                  <div className="w-full min-w-0 space-y-2">
                    <MessageErrorView error={loadError ?? connectionError!} />
                    {connectionError && onOpenSettings && (
                      <button
                        type="button"
                        onClick={onOpenSettings}
                        className="rounded-md border border-border-200 bg-bg-100 px-3 py-1.5 text-[length:var(--fs-sm)] text-text-200 transition-colors hover:bg-bg-200"
                      >
                        {t('chatArea.openServerSettings')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 压缩进行中：消息流底部的行内指示——沿用"历史已压缩"分隔线视觉
                （居中标签 + 两侧细线），中间换成 spinner；取消走输入框停止按钮 */}
            {isCompacting && sessionId && (
              <div className={`w-full ${maxWidthClass} mx-auto ${paddingClass}`}>
                <div className="flex w-full items-center gap-2 px-3 py-1.5 text-[length:var(--fs-sm)] text-text-500">
                  <span className="flex-1 h-px bg-border-200/70" />
                  <span className="shrink-0 inline-flex items-center gap-1.5 text-[length:var(--fs-xs)] leading-none text-text-400">
                    <SpinnerIcon className="animate-spin" size={12} />
                    {t('chatArea.compacting')}
                  </span>
                  <span className="flex-1 h-px bg-border-200/70" />
                </div>
              </div>
            )}

            <div style={{ height: spacerHeight }} aria-hidden="true" />
          </div>
        </div>
      )
    },
  ),
)
