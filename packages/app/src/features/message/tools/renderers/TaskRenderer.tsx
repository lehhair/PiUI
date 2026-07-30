import { memo, useState, useCallback, useRef, useEffect, type RefCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ContentBlock } from '../../../../components'
import { ChevronRightIcon, ExternalLinkIcon, StopIcon } from '../../../../components/Icons'
import { useDisclosureScrollLock, useResponsiveMaxHeight } from '../../../../hooks'
import { useSessionState, messageStore } from '../../../../store'
import { useSessionNavigation } from '../../../../contexts/SessionNavigationContext'
import { abortSession } from '../../../../api'
import { sessionErrorHandler } from '../../../../utils'
import { formatToolName } from '../../../../utils/formatUtils'
import { useUiDisclosureState } from '../../../../utils/uiDisclosureState'
import type { ToolRendererProps } from '../types'
import { MessageExpandPanel, useMessageExpandRender } from '../../messageExpand'
import type { Message, TextPart, ToolPart } from '../../../../types/message'
import { isVisibleTextPart } from '../../../../types/message'
import { loadPiSessionToUi } from '../../../../pi/applySnapshot'

const EMPTY_MESSAGES: Message[] = []

// ============================================
// Task Tool Renderer (子 agent)
//
// 设计原则：
// 1. 渐进式展开 - 默认显示摘要，点击展开详情
// 2. 视觉层次 - 左侧缩进线区分嵌套层级
// 3. 状态优先 - 运行中/完成/错误状态一目了然
// 4. 按需交互 - 输入框只在需要时显示
// ============================================

export const TaskRenderer = memo(function TaskRenderer({ execution, partKey, onFullscreenChange }: ToolRendererProps) {
  const { t } = useTranslation('message')
  const { currentDirectory } = useSessionNavigation()
  const isRunning = !execution.result
  const isCompleted = Boolean(execution.result && !execution.result.isError)
  const isError = Boolean(execution.result?.isError)
  const [expanded, setExpanded] = useUiDisclosureState(
    `message:${partKey}:task-body`,
    isRunning,
  )
  const [isContentFullscreen, setIsContentFullscreen] = useState(false)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const effectiveExpanded = expanded || isContentFullscreen
  const shouldRenderBody = useMessageExpandRender(effectiveExpanded)

  // 从 input 中提取任务信息
  const input = execution.call.arguments as Record<string, unknown> | undefined
  const description = (input?.description as string) || t('task.subtask')
  const prompt = (input?.prompt as string) || ''
  const agentType = (input?.subagent_type as string) || 'general'

  // 获取子 session ID —— 只信任 metadata.sessionId，它是后端为这个 tool call 精确设置的
  const metadata = execution.result?.details && typeof execution.result.details === 'object' && !Array.isArray(execution.result.details)
    ? execution.result.details as Record<string, unknown>
    : undefined
  const targetSessionId = metadata?.sessionId as string | undefined

  const resultOutput = execution.result
    ? execution.result.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
    : undefined

  const handleContentFullscreenChange = useCallback(
    (isFullscreen: boolean) => {
      setIsContentFullscreen(isFullscreen)
      onFullscreenChange?.(isFullscreen)
    },
    [onFullscreenChange],
  )

  // Stop handler
  const handleStop = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!targetSessionId) return
      abortSession(targetSessionId, currentDirectory || '')
    },
    [targetSessionId, currentDirectory],
  )

  // 运行时自动展开
  useEffect(() => {
    let frameId: number | null = null

    if (isRunning) {
      frameId = requestAnimationFrame(() => {
        setExpanded(true, { touched: false, respectUser: true })
      })
    }

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
    }
  }, [isRunning, setExpanded])

  return (
    <div ref={rootRef} className="min-w-0">
      <div>
        {/* Header */}
        <TaskHeader
          agentType={agentType}
          description={description}
          status={isRunning ? 'running' : isError ? 'error' : 'completed'}
          expanded={expanded}
          headerRef={headerRef}
          onToggle={() => withScrollLock(() => setExpanded(!expanded))}
          sessionId={targetSessionId}
          onStop={isRunning ? handleStop : undefined}
        />

        {/* Body */}
        <MessageExpandPanel open={effectiveExpanded} innerClassName="overflow-hidden">
          {shouldRenderBody && (
            <div className="pt-2 space-y-3">
              {/* Prompt */}
              {prompt && (
                <div className="text-[length:var(--fs-xs)] text-text-500 leading-relaxed whitespace-nowrap overflow-hidden text-ellipsis">
                  {prompt}
                </div>
              )}

              {/* 子会话内容 */}
              {targetSessionId && (
                <>
                  {prompt && <hr className="border-border-200/30" />}
                  <SubSessionView sessionId={targetSessionId} isParentRunning={isRunning} />
                </>
              )}

              {/* 完成时的输出 */}
              {isCompleted && resultOutput !== undefined && resultOutput !== '' && (
                <ContentBlock
                  label={t('task.result')}
                  stateKey={`message:${partKey}:task-result`}
                  content={resultOutput}
                  defaultCollapsed={true}
                  onFullscreenChange={handleContentFullscreenChange}
                  fullscreenId={`task:${partKey}:result`}
                />
              )}

              {/* 错误信息 */}
              {isError && (
                <ContentBlock
                  label={t('task.error')}
                  stateKey={`message:${partKey}:task-error`}
                  content={resultOutput || 'Task failed'}
                  variant="error"
                  onFullscreenChange={handleContentFullscreenChange}
                  fullscreenId={`task:${partKey}:error`}
                />
              )}
            </div>
          )}
        </MessageExpandPanel>
      </div>
    </div>
  )
})

// ============================================
// Task Header
// ============================================

interface TaskHeaderProps {
  agentType: string
  description: string
  status: string
  expanded: boolean
  onToggle: () => void
  headerRef?: RefCallback<HTMLElement>
  sessionId?: string
  onStop?: (e: React.MouseEvent) => void
}

export const TaskHeader = memo(function TaskHeader({
  agentType,
  description,
  status,
  expanded,
  onToggle,
  headerRef,
  sessionId,
  onStop,
}: TaskHeaderProps) {
  const { t } = useTranslation('message')
  const { navigateToSession, currentDirectory } = useSessionNavigation()
  const handleOpenSession = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!sessionId) return
      navigateToSession(sessionId, currentDirectory || undefined)
    },
    [sessionId, navigateToSession, currentDirectory],
  )

  const isRunning = status === 'running' || status === 'pending'
  const isError = status === 'error'
  const isCompleted = status === 'completed'

  const agentBadgeClass = `shrink-0 px-1.5 py-0.5 text-[length:var(--fs-xxs)] font-medium rounded-xs ${
    isRunning
      ? 'bg-accent-main-100/20 text-accent-main-100'
      : isError
        ? 'bg-danger-100/20 text-danger-100'
        : isCompleted
          ? 'bg-accent-secondary-100/20 text-accent-secondary-100'
          : 'bg-bg-300 text-text-300'
  }`

  return (
    <div ref={headerRef} className="flex items-center gap-2 py-1 group">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? t('showLess') : t('showMore')}
        title={expanded ? t('showLess') : t('showMore')}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm text-text-400 transition-colors hover:bg-bg-200/70 hover:text-text-100 bg-transparent border-none p-0"
      >
        {/* Expand icon */}
        <span className={`text-text-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>
          <ChevronRightIcon size={12} />
        </span>
      </button>

      {sessionId ? (
        <button
          type="button"
          onClick={handleOpenSession}
          className={`${agentBadgeClass} border-none transition-opacity hover:opacity-80`}
          title={t('task.openSession')}
        >
          {agentType}
        </button>
      ) : (
        <span className={agentBadgeClass}>{agentType}</span>
      )}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group/title flex min-w-0 flex-1 self-stretch items-center text-left bg-transparent border-none p-0"
        title={expanded ? t('showLess') : t('showMore')}
      >
        <span className="min-w-0 truncate text-[length:var(--fs-sm)] text-text-300 group-hover/title:text-text-100">
          {description}
        </span>
      </button>

      {/* Stop button (running) */}
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          aria-label={t('task.stop')}
          className="flex-shrink-0 w-[18px] h-[18px] p-0 flex items-center justify-center text-text-400 hover:text-danger-100 hover:bg-danger-100/10 rounded-sm transition-colors active:scale-90 bg-transparent border-none"
          title={t('task.stop')}
        >
          <StopIcon size={10} />
        </button>
      )}

      {/* Open session */}
      {sessionId && (
        <button
          type="button"
          onClick={handleOpenSession}
          aria-label={t('task.openSession')}
          className="flex-shrink-0 p-1 text-text-500 hover:text-accent-main-100 transition-all bg-transparent border-none"
          title={t('task.openSession')}
        >
          <ExternalLinkIcon size={12} />
        </button>
      )}
    </div>
  )
})

// ============================================
// Sub Session View
// ============================================

interface SubSessionViewProps {
  sessionId: string
  isParentRunning: boolean
}

const SubSessionView = memo(function SubSessionView({ sessionId }: SubSessionViewProps) {
  const { t } = useTranslation('message')
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadedRef = useRef(false)
  const isAtBottomRef = useRef(true)
  const subSessionMaxHeight = useResponsiveMaxHeight(0.25, 120, 240)

  const sessionState = useSessionState(sessionId)
  const messages = sessionState?.messages ?? EMPTY_MESSAGES
  const isStreaming = sessionState?.isStreaming || false
  const isLoading = sessionState?.loadState === 'loading'

  // 挂载即加载（SubSessionView 只在 task 展开时才渲染，loadedRef 防止重复请求）
  useEffect(() => {
    if (loadedRef.current) return

    const state = messageStore.getSessionState(sessionId)
    if (state && (state.messages.length > 0 || state.isStreaming)) {
      loadedRef.current = true
      return
    }

    loadedRef.current = true
    messageStore.setLoadState(sessionId, 'loading')

    loadPiSessionToUi(sessionId, { activate: false })
      .catch(err => {
        sessionErrorHandler('load sub-session', err)
        messageStore.setLoadState(sessionId, 'error')
      })
  }, [sessionId])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [])

  // 用户不在底部时不强制滚动
  useEffect(() => {
    if (!isStreaming) return
    const el = scrollRef.current
    if (!el || !isAtBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, isStreaming])

  // 过滤有内容的消息
  const visibleMessages = messages.filter((msg: Message) =>
    msg.parts.some((part: Message['parts'][0]) => {
      if (part.type === 'text') return isVisibleTextPart(part)
      if (part.type === 'tool') return true
      if (part.type === 'reasoning') return true
      return false
    }),
  )

  if (isLoading && messages.length === 0) {
    return <MessageSkeleton />
  }

  if (visibleMessages.length === 0) {
    return <div className="text-[length:var(--fs-sm)] text-text-500 italic py-2">{t('task.waitingForResponse')}</div>
  }

  return (
    <div className="rounded-md bg-bg-100/50 border border-border-200/30 overflow-hidden">
      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-y-auto custom-scrollbar px-3 py-2 space-y-2"
        style={{ maxHeight: subSessionMaxHeight }}
      >
        {visibleMessages.map((msg: Message, idx: number) => (
          <MessageItem key={msg.info.id} message={msg} isLast={idx === visibleMessages.length - 1} />
        ))}
      </div>
    </div>
  )
})

// ============================================
// Message Item
// ============================================

interface MessageItemProps {
  message: Message
  isLast: boolean
}

const MessageItem = memo(function MessageItem({ message, isLast }: MessageItemProps) {
  const { info, parts } = message
  const isUser = info.role === 'user'

  const textParts = parts.filter((p): p is TextPart => p.type === 'text' && !!p.text?.trim())
  const toolParts = parts.filter((p): p is ToolPart => p.type === 'tool')

  const textContent = textParts
    .map(p => p.text)
    .join('\n')
    .trim()

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-2.5 py-1.5 rounded-md bg-bg-300 text-text-100 text-[length:var(--fs-xs)] whitespace-pre-wrap break-words">
          {textContent}
        </div>
      </div>
    )
  }

  // Assistant message
  return (
    <div className="space-y-1.5">
      {/* Text content */}
      {textContent && (
        <div className="text-[length:var(--fs-xs)] text-text-200 leading-relaxed whitespace-pre-wrap">
          {textContent.length > 500 && !isLast ? textContent.slice(0, 500) + '...' : textContent}
        </div>
      )}

      {/* Tool calls - compact summary */}
      {toolParts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {toolParts.map((tool, idx) => (
            <ToolBadge key={idx} tool={tool} />
          ))}
        </div>
      )}
    </div>
  )
})

// ============================================
// Tool Badge
// ============================================

const ToolBadge = memo(function ToolBadge({ tool }: { tool: ToolPart }) {
  const { state, tool: toolName } = tool
  const isRunning = state.status === 'running' || state.status === 'pending'
  const isError = state.status === 'error'

  const title = state.title || formatToolName(toolName)
  const displayTitle = title.length > 30 ? title.slice(0, 30) + '...' : title

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xs text-[length:var(--fs-xxs)] font-mono ${
        isRunning
          ? 'bg-accent-main-100/10 text-accent-main-100'
          : isError
            ? 'bg-danger-100/10 text-danger-100'
            : 'bg-bg-200 text-text-400'
      }`}
    >
      {isRunning && <span className="w-1 h-1 rounded-full bg-current animate-pulse" />}
      {displayTitle}
    </span>
  )
})

// ============================================
// Message Skeleton
// ============================================

function MessageSkeleton() {
  return (
    <div className="rounded-md bg-bg-100/50 border border-border-200/30 p-3 space-y-2">
      <div className="h-3 bg-bg-300/50 rounded animate-pulse w-3/4" />
      <div className="h-3 bg-bg-300/50 rounded animate-pulse w-1/2" />
      <div className="h-3 bg-bg-300/50 rounded animate-pulse w-2/3" />
    </div>
  )
}

// ============================================
// Icons & Helpers
// ============================================
