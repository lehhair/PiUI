import { memo, useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { animate } from 'motion/mini'
import { ChevronDownIcon, ChevronRightIcon, SplitIcon, SpinnerIcon, UndoIcon } from '../../components/Icons'
import { CopyButton, SmoothHeight } from '../../components/ui'
import { MarkdownRenderer } from '../../components/MarkdownRenderer'
import { useDisclosureScrollLock } from '../../hooks'
import { useInputCapabilities } from '../../hooks/useInputCapabilities'
import { useNow } from '../../hooks/useNow'
import { useTheme } from '../../hooks/useTheme'
import {
  TextPartView,
  ReasoningPartView,
  MessageErrorView,
  ToolGroup,
} from './parts'
import { PiSystemItemView } from './parts/PiSystemItemViews'
import { MSG_SPACING } from './messageSpacing'
import { MessageExpandPanel, useMessageExpandRender } from './messageExpand'
import type { MessageError } from '../../types/message'
import type {
  PiAssistantMessageItem,
  PiTimelineItem,
  PiToolExecution,
  PiUserMessageItem,
} from '../../pi/domain/index.js'
import type { ImageContent } from '@earendil-works/pi-ai'
import { AttachmentItem } from '../attachment/index.js'
import type { Attachment } from '../attachment/index.js'

/** ImageContent -> Attachment for the attachment capsule renderer */
function imageToAttachment(block: ImageContent, id: string): Attachment {
  const ext = block.mimeType.split('/')[1] || 'png'
  return {
    id,
    type: 'file',
    displayName: `image.${ext}`,
    url: `data:${block.mimeType};base64,${block.data}`,
    mime: block.mimeType,
  }
}
import {
  ENTRY_GROW_DURATION_MS,
  isEntryGrowComplete,
  markEntryGrowComplete,
  shouldPlayEntryGrow,
} from '../../utils/entryGrow'
import {
  formatDuration,
  formatProcessDuration,
} from '../../utils/formatUtils'
import { lockScrollAroundAnchor } from '../../utils/scrollUtils'
import { useUiDisclosureState } from '../../utils/uiDisclosureState'

/**
 * 过程折叠 header：进行中自己走表，只有这一行因计时更新；children 不跟时钟走。
 */
const ProcessCollapseHeader = memo(function ProcessCollapseHeader({
  isActive,
  startedAt,
  durationMs,
  expanded,
  onToggle,
  headerRef,
}: {
  isActive: boolean
  startedAt?: number
  durationMs?: number
  expanded: boolean
  onToggle: () => void
  headerRef: React.RefObject<HTMLButtonElement | null>
}) {
  const { t } = useTranslation('message')
  const now = useNow(1000, isActive && startedAt != null)
  const liveMs = isActive && startedAt != null ? Math.max(0, now - startedAt) : null
  const lastLiveMsRef = useRef(0)
  if (liveMs != null) lastLiveMsRef.current = liveMs
  const displayMs =
    liveMs != null
      ? liveMs
      : durationMs != null && durationMs > 0
        ? durationMs
        : lastLiveMsRef.current
  // Working/Worked：整秒无小数；超过 1 分钟带 m（如 3m 12s）
  const durationLabel = formatProcessDuration(displayMs)
  const label = isActive
    ? t('processingWithDuration', { duration: durationLabel })
    : t('processedFor', { duration: durationLabel })

  return (
    <button
      ref={headerRef}
      type="button"
      onClick={onToggle}
      className={`flex w-full items-center gap-1.5 rounded-md ${MSG_SPACING.header} text-left text-[length:var(--fs-sm)] leading-5 text-text-400 hover:bg-bg-200/30 hover:text-text-200 transition-colors`}
    >
      <span className={isActive ? 'reasoning-shimmer-text' : 'text-text-400'}>{label}</span>
      <span className="inline-flex items-center justify-center text-text-500">
        {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
      </span>
    </button>
  )
})

/** 过程折叠块：动画与 tool steps 一致（grid-rows + delayed body） */
export function ProcessCollapseBlock({
  children,
  durationMs,
  startedAt,
  isActive,
  stateKey,
}: {
  children: ReactNode
  durationMs?: number
  startedAt?: number
  isActive: boolean
  stateKey: string
}) {
  const [expanded, setExpanded, touched] = useUiDisclosureState(stateKey, isActive)
  // Automatic settling happens with the final answer moving outside the
  // process shell. Animating that height makes the virtualizer measure the
  // same row repeatedly while its contents move.
  const settledExpanded = !isActive && !touched ? false : expanded
  const shouldRenderBody = useMessageExpandRender(settledExpanded)
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLButtonElement>(null)
  const unlockScrollRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    setExpanded(isActive, { touched: false, respectUser: true })
  }, [isActive, setExpanded])

  useEffect(() => {
    return () => {
      unlockScrollRef.current?.()
      unlockScrollRef.current = null
    }
  }, [])

  const toggleExpanded = useCallback(() => {
    unlockScrollRef.current?.()
    unlockScrollRef.current = lockScrollAroundAnchor(headerRef.current, {
      observe: rootRef.current,
    })
    setExpanded(!expanded)
  }, [expanded, setExpanded])

  // 进行中默认展开：不要跑 grid 展开动画（否则每条新消息都带动画高度重排）
  // 用户手动折叠/展开、或结束后自动收起时再开动画
  // 挂载本身不另做入场生长——像普通消息一样直接出现
  const animateGrid = !(!isActive && !touched) && expanded !== isActive

  return (
    <div ref={rootRef} className="flex flex-col">
      <ProcessCollapseHeader
        isActive={isActive}
        startedAt={startedAt}
        durationMs={durationMs}
        expanded={settledExpanded}
        onToggle={toggleExpanded}
        headerRef={headerRef}
      />
      <MessageExpandPanel open={settledExpanded} animate={animateGrid} clip>
        {shouldRenderBody && <div className={MSG_SPACING.processBody}>{children}</div>}
      </MessageExpandPanel>
    </div>
  )
}

/**
 * 消息内容范围：
 * - all: 正常渲染
 * - process: 只渲染过程部分（进外层折叠块）
 * - final: 只渲染尾部最终 text
 * - inline: 完整渲染（已在外层过程块内）
 */
export type ProcessContentScope = 'all' | 'process' | 'final' | 'inline'

type ProcessSplit = {
  processItems: RenderItem[]
  finalItems: RenderItem[]
  hasProcess: boolean
  hasFinal: boolean
}

/**
 * 把 render items 拆成「过程」和「最终回答」。
 * 最终回答 = 消息中最后一段连续 text。
 * thinking / tool 永远进过程。
 */
export function splitProcessRenderItems(items: RenderItem[]): ProcessSplit {
  if (items.length === 0) {
    return { processItems: [], finalItems: [], hasProcess: false, hasFinal: false }
  }

  let lastTextIdx = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type === 'single' && item.block.type === 'text') {
      lastTextIdx = i
      break
    }
    break
  }

  if (lastTextIdx < 0) {
    return {
      processItems: items,
      finalItems: [],
      hasProcess: items.length > 0,
      hasFinal: false,
    }
  }

  let textRunStart = lastTextIdx
  while (textRunStart > 0) {
    const prev = items[textRunStart - 1]
    if (prev.type === 'single' && prev.block.type === 'text') {
      textRunStart -= 1
      continue
    }
    break
  }

  const finalItems = items.slice(textRunStart, lastTextIdx + 1)
  const processItems = items.slice(0, textRunStart)

  return {
    processItems,
    finalItems,
    hasProcess: processItems.length > 0,
    hasFinal: finalItems.length > 0,
  }
}

/** 流式未完成时不拆 final：中间 text 后面还可能跟 tool */
export function assistantStillStreamingProcess(item: PiAssistantMessageItem): boolean {
  return Boolean(item.isStreaming)
}

/** 是否有过程内容（thinking/tool/非尾部 text） */
export function assistantHasProcessContent(item: PiAssistantMessageItem): boolean {
  const items = groupBlocksForRender(item)
  if (items.length === 0) return false
  if (assistantStillStreamingProcess(item)) return true
  return splitProcessRenderItems(items).hasProcess
}

/** 是否有应留在折叠块外的最终 text（仅消息已结束后才拆） */
export function assistantHasFinalContent(item: PiAssistantMessageItem): boolean {
  if (assistantStillStreamingProcess(item)) return false
  return splitProcessRenderItems(groupBlocksForRender(item)).hasFinal
}

interface MessageRendererProps {
  item: PiTimelineItem
  allowStreamingLayoutAnimation?: boolean
  /** 回合总时长（毫秒），仅在回合最后一条 assistant 消息上有值 */
  turnDuration?: number
  /**
   * 是否为该用户回合的最后一条可见 assistant。
   * latestOnly 开启时，中间 assistant 不显示 step 完成信息。
   * 未传入时按 true 处理（单条消息场景）。
   */
  isTurnLatestAssistant?: boolean
  /** 过程折叠时的内容范围 */
  processContentScope?: ProcessContentScope
  onUndo?: (entryId: string) => void
  onFork?: (entryId: string, forkMessageId?: string) => Promise<void> | void
  forkMessageId?: string
  canUndo?: boolean
  /** 用户消息入场生长完成（供过程壳等待挂载） */
  onEntryGrowComplete?: (entryId: string) => void
}

export const MessageRenderer = memo(function MessageRenderer({
  item,
  allowStreamingLayoutAnimation = false,
  turnDuration,
  isTurnLatestAssistant = true,
  processContentScope = 'all',
  onUndo,
  onFork,
  forkMessageId,
  canUndo,
  onEntryGrowComplete,
}: MessageRendererProps) {
  if (item.kind === 'user_message') {
    return (
      <UserMessageView
        item={item}
        onUndo={onUndo}
        onFork={onFork}
        forkMessageId={forkMessageId}
        canUndo={canUndo}
        onEntryGrowComplete={onEntryGrowComplete}
      />
    )
  }

  if (item.kind === 'assistant_message') {
    return (
      <AssistantMessageView
        item={item}
        allowStreamingLayoutAnimation={allowStreamingLayoutAnimation}
        turnDuration={turnDuration}
        isTurnLatestAssistant={isTurnLatestAssistant}
        processContentScope={processContentScope}
      />
    )
  }

  return <PiSystemItemView item={item} />
})

// ============================================
// 入场生长动画 hook — 新消息作为对话流的延续，从 height 0 平滑展开
// 完成后 markEntryGrowComplete，供过程壳「等用户登场完再挂」使用
// ============================================

function useEntryGrowAnimation(
  created: number,
  enabled = true,
  completeId?: string,
  onComplete?: (id: string) => void,
) {
  const ref = useRef<HTMLDivElement>(null)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useLayoutEffect(() => {
    const el = ref.current
    const finish = () => {
      if (!completeId) return
      if (!isEntryGrowComplete(completeId)) markEntryGrowComplete(completeId)
      onCompleteRef.current?.(completeId)
    }

    // 过程壳内消息禁止入场生长：会连着虚拟行反复 measure，造成整列高度抽搐
    if (!enabled || !el) {
      finish()
      return
    }
    // 已完成过（虚拟行复用 remount）或消息太旧：不播，直接放行
    if ((completeId && isEntryGrowComplete(completeId)) || !shouldPlayEntryGrow(created)) {
      finish()
      return
    }

    const targetHeight = el.scrollHeight
    el.style.height = '0px'
    el.style.clipPath = 'inset(0 -100% 0 -100%)'
    let cancelled = false
    animate(el, { height: `${targetHeight}px` }, { duration: ENTRY_GROW_DURATION_MS / 1000, ease: 'easeOut' }).then(
      () => {
        if (cancelled) return
        el.style.height = ''
        el.style.clipPath = ''
        finish()
      },
    )
    return () => {
      cancelled = true
      // 虚拟行中途卸载也放行，避免 Working 壳永远等不到入场完成
      el.style.height = ''
      el.style.clipPath = ''
      finish()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return ref
}

// ============================================
// Collapsible User Text
// ============================================

/** 默认预览 8 行 */
const COLLAPSE_PREVIEW_LINES = 8
const LEADING_RELAXED = 1.625
const USER_HTML_ARTIFACT_PATTERN = /(?:```(?:html|htm)\b|<!doctype\s+html\b|<html\b|<style\b|<script\b|<canvas\b|\son[a-z]+\s*=)/i

// 折叠状态缓存：消息是否溢出
const overflowStateCache = new Map<string, boolean>()

const CollapsibleUserText = memo(function CollapsibleUserText({
  text,
  collapseEnabled,
  renderMarkdown,
  messageId,
}: {
  text: string
  collapseEnabled: boolean
  renderMarkdown: boolean
  messageId: string
}) {
  const { t } = useTranslation('message')
  const contentRef = useRef<HTMLDivElement>(null)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const overflowCacheKey = `${messageId}:${renderMarkdown ? 'markdown' : 'plain'}`
  const [expanded, setExpanded] = useUiDisclosureState(`message:${messageId}:user-text`, false)
  const [isOverflow, setIsOverflow] = useState(() => overflowStateCache.get(overflowCacheKey) ?? false)

  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return

    let disposed = false
    const measure = () => {
      if (disposed) return
      const fsBase = Number.parseFloat(window.getComputedStyle(el).getPropertyValue('--fs-base'))
      if (!Number.isFinite(fsBase) || fsBase <= 0) return
      const collapsedHeight = fsBase * LEADING_RELAXED * COLLAPSE_PREVIEW_LINES
      const next = el.scrollHeight > collapsedHeight + 1
      overflowStateCache.set(overflowCacheKey, next)
      setIsOverflow(prev => (prev === next ? prev : next))
    }

    measure()
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(el)
    document.fonts?.ready?.then(measure)

    return () => {
      disposed = true
      resizeObserver.disconnect()
    }
  }, [text, overflowCacheKey])

  const hasHtmlArtifact = renderMarkdown && USER_HTML_ARTIFACT_PATTERN.test(text)
  const showCollapse = collapseEnabled && !hasHtmlArtifact && isOverflow
  const isCollapsed = collapseEnabled && !hasHtmlArtifact && !expanded

  return (
    <div
      ref={rootRef}
      className={`px-4 py-2.5 bg-bg-300 rounded-2xl max-w-full ${hasHtmlArtifact ? 'w-full max-w-2xl' : ''}`}
    >
      <div className="relative">
        <div
          ref={node => {
            contentRef.current = node
            headerRef(node)
          }}
          className={`m-0 break-words text-[length:var(--fs-base)] text-text-100 leading-relaxed${
            renderMarkdown ? '' : ' whitespace-pre-wrap'
          }${
            isCollapsed ? ' overflow-hidden' : ''
          }`}
          style={
            isCollapsed
              ? {
                  maxHeight: `calc(var(--fs-base) * ${LEADING_RELAXED} * ${COLLAPSE_PREVIEW_LINES})`,
                  contain: 'layout paint',
                }
              : undefined
          }
        >
          {renderMarkdown ? <MarkdownRenderer content={text} /> : text}
        </div>
        {/* 底部渐变遮罩 */}
        {showCollapse && isCollapsed && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-bg-300 to-transparent pointer-events-none" />
        )}
      </div>
      {showCollapse && (
        <button
          type="button"
          onClick={() => withScrollLock(() => setExpanded(prev => !prev))}
          className="mt-1 text-[length:var(--fs-sm)] text-text-400 hover:text-text-200 transition-colors"
          aria-expanded={expanded}
        >
          {expanded ? t('showLess') : t('showMore')}
        </button>
      )}
    </div>
  )
})

interface ForkActionButtonProps {
  entryId: string
  onFork?: (entryId: string, forkMessageId?: string) => Promise<void> | void
  forkMessageId?: string
}

const ForkActionButton = memo(function ForkActionButton({ entryId, onFork, forkMessageId }: ForkActionButtonProps) {
  const { t } = useTranslation('message')
  const [isForking, setIsForking] = useState(false)

  const handleFork = useCallback(async () => {
    if (!onFork || isForking) return

    setIsForking(true)

    try {
      await onFork(entryId, forkMessageId)
    } catch {
      // 业务错误由上层统一处理
    } finally {
      setIsForking(false)
    }
  }, [forkMessageId, isForking, entryId, onFork])

  if (!onFork) return null

  return (
    <button
      onClick={() => void handleFork()}
      disabled={isForking}
      className="p-1.5 rounded-md transition-colors duration-150 text-text-400 hover:text-text-200 disabled:cursor-default disabled:text-text-500"
      title={isForking ? t('forkingFromHere') : t('forkFromHere')}
      aria-label={isForking ? t('forkingFromHere') : t('forkFromHere')}
    >
      {isForking ? <SpinnerIcon className="animate-spin" /> : <SplitIcon />}
    </button>
  )
})

// ============================================
// User Message View
// ============================================

interface UserMessageViewProps {
  item: PiUserMessageItem
  onUndo?: (entryId: string) => void
  onFork?: (entryId: string, forkMessageId?: string) => Promise<void> | void
  forkMessageId?: string
  canUndo?: boolean
  onEntryGrowComplete?: (entryId: string) => void
}

/** PC 精细指针：默认隐藏，悬浮消息/聚焦时显示；触控优先设备始终显示 */
function useMessageActionBarClass() {
  const { preferTouchUi } = useInputCapabilities()
  return preferTouchUi
    ? 'flex items-center gap-1 transition-opacity'
    : 'flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto focus-within:pointer-events-auto transition-opacity'
}

const UserMessageView = memo(function UserMessageView({
  item,
  onUndo,
  onFork,
  forkMessageId,
  canUndo,
  onEntryGrowComplete,
}: UserMessageViewProps) {
  const { t } = useTranslation('message')
  const { blocks, entryId } = item
  const { collapseUserMessages, renderUserMarkdown } = useTheme()
  const actionBarClass = useMessageActionBarClass()

  const wrapperRef = useEntryGrowAnimation(item.timestamp, true, entryId, onEntryGrowComplete)

  // 文本块拼接；图片块走附件胶囊渲染（AttachmentItem 通用消费）
  const textBlocks = blocks.filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
  const imageBlocks = blocks.filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image')
  const messageText = textBlocks.map(block => block.text).join('')
  const hasUserHtmlArtifact = renderUserMarkdown && USER_HTML_ARTIFACT_PATTERN.test(messageText)

  return (
    <div
      ref={wrapperRef}
      data-user-html-artifact={hasUserHtmlArtifact ? '' : undefined}
      className={`flex flex-col items-end group ${hasUserHtmlArtifact ? 'w-full' : ''}`}
    >
      <div className="flex flex-col gap-1 items-end w-full">
        {/* 消息文本 */}
        {messageText && (
          <CollapsibleUserText
            text={messageText}
            collapseEnabled={collapseUserMessages}
            renderMarkdown={renderUserMarkdown}
            messageId={entryId}
          />
        )}

        {/* 图片附件（胶囊） */}
        {imageBlocks.length > 0 && (
          <div className="mt-1 flex max-w-full min-w-0 flex-wrap gap-2 justify-end">
            {imageBlocks.map((block, i) => (
              <AttachmentItem
                key={`${entryId}:img:${i}`}
                attachment={imageToAttachment(block, `${entryId}:img:${i}`)}
                expandable
                size="sm"
              />
            ))}
          </div>
        )}

        {/* Action buttons — PC 悬浮消息显示；触控设备始终显示 */}
        <div className={actionBarClass}>
          {/* Undo button */}
          {canUndo && onUndo && (
            <button
              onClick={() => onUndo(entryId)}
              className="p-1.5 rounded-md transition-colors duration-150 text-text-400 hover:text-text-200"
              title={t('undoFromHere')}
            >
              <UndoIcon />
            </button>
          )}
          <ForkActionButton entryId={entryId} onFork={onFork} forkMessageId={forkMessageId} />
          {/* Copy button */}
          {messageText && <CopyButton text={messageText} position="static" />}
        </div>
      </div>
    </div>
  )
})

// ============================================
// Assistant Message View
// ============================================

const AssistantMessageView = memo(function AssistantMessageView({
  item,
  allowStreamingLayoutAnimation = false,
  turnDuration,
  isTurnLatestAssistant = true,
  processContentScope = 'all',
}: {
  item: PiAssistantMessageItem
  allowStreamingLayoutAnimation?: boolean
  turnDuration?: number
  isTurnLatestAssistant?: boolean
  processContentScope?: ProcessContentScope
  forkMessageId?: string
}) {
  const { t } = useTranslation('message')
  const isStreaming = Boolean(item.isStreaming)
  const { message, blocks } = item
  const { stepFinishDisplay, actionsOnLatestAssistantOnly } = useTheme()
  // 分叉/复制：默认只在回合末尾助手消息显示，避免连续多条打断阅读
  // final 位始终显示操作；process/inline 不显示（避免壳内外重复）
  const showMessageActions =
    processContentScope !== 'process' &&
    processContentScope !== 'inline' &&
    (!actionsOnLatestAssistantOnly || isTurnLatestAssistant || processContentScope === 'final')
  const actionBarClass = useMessageActionBarClass()

  // 壳内（process/inline）和壳外 final 都别做 height 0→N：final 也是拆分后新挂载，动画会顶布局
  const allowEntryGrow = processContentScope === 'all'
  const wrapperRef = useEntryGrowAnimation(item.timestamp, allowEntryGrow)

  // 收集连续的 tool calls 合并渲染；过程折叠时按 scope 拆分
  const renderItems = useMemo(() => {
    const items = groupBlocksForRender(item)
    if (processContentScope === 'all' || processContentScope === 'inline') return items
    // 流式未完成：整袋当 process，不拆 final
    if (assistantStillStreamingProcess(item)) {
      return processContentScope === 'process' ? items : []
    }
    const split = splitProcessRenderItems(items)
    if (processContentScope === 'process') return split.processItems
    if (processContentScope === 'final') return split.finalItems
    return items
  }, [item, processContentScope])

  // 判断哪些 thinking block 已经结束（后面出现了任何其他 block）
  const endedReasoningIndexes = useMemo(() => {
    const ended = new Set<number>()
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].type !== 'thinking') continue
      for (let j = i + 1; j < blocks.length; j++) {
        // 任何后续 block 都说明思考已结束
        ended.add(i)
        break
      }
    }
    return ended
  }, [blocks])

  // 计算完整文本用于复制
  const fullText = useMemo(
    () =>
      blocks
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join(''),
    [blocks],
  )
  const hasCopyableText = fullText.trim().length > 0

  // 消息级别错误（stopReason error/aborted）
  const messageError: MessageError | undefined =
    message.stopReason === 'error'
      ? { name: 'UnknownError', data: { message: message.errorMessage ?? t('errors.unknownErrorDesc') } }
      : message.stopReason === 'aborted'
        ? { name: 'MessageAbortedError', data: { message: message.errorMessage ?? t('errors.messageAborted') } }
        : undefined

  // agent / model（仅 assistant 消息）
  const modelLabel = message.model || undefined

  const showTurnDurationFooter =
    !isStreaming && stepFinishDisplay.turnDuration && turnDuration != null && turnDuration > 0
  const showCompletedAtFooter = false

  if (blocks.length === 0) {
    // Pi has no parts hydration — empty content is truly empty.
    // Streaming shells (Working indicator) are handled by the process
    // collapse layer; an empty message must not occupy a row.
    if (messageError) {
      return (
        <div className={`flex flex-col ${MSG_SPACING.stack} w-full`}>
          <MessageErrorView error={messageError} stateKey={`message:${item.entryId}:error`} />
        </div>
      )
    }
    return null
  }

  // process/final 拆完后可能为空
  if (renderItems.length === 0 && processContentScope !== 'all' && processContentScope !== 'inline') {
    return null
  }

  return (
    <div ref={wrapperRef} className={`flex flex-col ${MSG_SPACING.stack} w-full group`}>
      {/* 流式增高走自然撑开 + 贴底 scroll，默认不做 height 补间，避免每帧 layout/remeasure */}
      <SmoothHeight isActive={!!isStreaming && allowStreamingLayoutAnimation && processContentScope === 'all'}>
        <div className={`flex flex-col ${MSG_SPACING.stack}`}>
          {renderItems.map((renderItem: RenderItem) => {
            if (renderItem.type === 'tool-group') {
              return (
                <ToolGroup
                  key={`${item.entryId}:tg:${renderItem.firstIndex}`}
                  groupId={item.entryId}
                  startedAt={item.timestamp}
                  executions={renderItem.executions}
                  isStreaming={isStreaming}
                  modelLabel={modelLabel}
                />
              )
            }

            const block = renderItem.block
            switch (block.type) {
              case 'text':
                return (
                  <TextPartView
                    key={`${item.entryId}:${renderItem.blockIndex}`}
                    part={block}
                    isStreaming={isStreaming}
                  />
                )
              case 'thinking': {
                const thinkingDone = endedReasoningIndexes.has(renderItem.blockIndex)
                return (
                  <ReasoningPartView
                    key={`${item.entryId}:${renderItem.blockIndex}`}
                    part={block}
                    partKey={`${item.entryId}:${renderItem.blockIndex}`}
                    isStreaming={isStreaming && !thinkingDone}
                  />
                )
              }
              default:
                return null
            }
          })}
        </div>
      </SmoothHeight>

      {/* Message-level error：过程壳内不重复挂错误 */}
      {messageError && processContentScope !== 'process' && processContentScope !== 'inline' && (
        <MessageErrorView error={messageError} stateKey={`message:${item.entryId}:error`} />
      )}

      {processContentScope !== 'process' && processContentScope !== 'inline' && (showTurnDurationFooter || showCompletedAtFooter) && (
        <div className="flex items-center gap-3 py-0.5 text-[length:var(--fs-xxs)] text-text-500">
          {showTurnDurationFooter && (
            <span>{t('stepFinish.totalDuration', { duration: formatDuration(turnDuration!) })}</span>
          )}
        </div>
      )}

      {showMessageActions && hasCopyableText && (
        <div className={actionBarClass}>
          <CopyButton text={fullText} position="static" />
        </div>
      )}
    </div>
  )
})

// ============================================
// Helper: Group parts for rendering
// ============================================

type PiContentBlock = PiAssistantMessageItem['blocks'][number]

type RenderItem =
  | { type: 'single'; block: PiContentBlock; blockIndex: number }
  | { type: 'tool-group'; executions: PiToolExecution[]; firstIndex: number }

/**
 * Group assistant content blocks for rendering: consecutive tool calls
 * merge into one tool-group item; text/thinking stay single items.
 * Tool results pair by call id from the owning assistant item.
 */
function groupBlocksForRender(item: PiAssistantMessageItem): RenderItem[] {
  const result: RenderItem[] = []
  let executions: PiToolExecution[] = []
  let firstIndex = 0

  const flushToolGroup = () => {
    if (executions.length === 0) return
    result.push({ type: 'tool-group', executions, firstIndex })
    executions = []
  }

  item.blocks.forEach((block, index) => {
    if (block.type === 'toolCall') {
      if (executions.length === 0) firstIndex = index
      executions.push({ call: block, result: item.toolResults[block.id] })
      return
    }
    flushToolGroup()
    result.push({ type: 'single', block, blockIndex: index })
  })

  flushToolGroup()
  return result
}
