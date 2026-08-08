import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { diffLines } from 'diff'
import { ChevronDownIcon, ChevronRightIcon } from '../../../components/Icons'
import type { PiToolExecution } from '../../../pi/domain/index.js'
import { useCompositorExpand, useDisclosureScrollLock } from '../../../hooks'
import { useNow } from '../../../hooks/useNow'
import { serverStore } from '../../../store/serverStore'
import { useTheme } from '../../../hooks/useTheme'
import { formatToolName, formatDuration } from '../../../utils/formatUtils'
import { useUiDisclosureState } from '../../../utils/uiDisclosureState'
import {
  getToolIcon,
  extractToolData,
  getToolConfig,
  DefaultRenderer,
  TodoRenderer,
  TaskRenderer,
  hasTodos,
} from '../tools'
import { MSG_SPACING } from '../messageSpacing'
import { MessageExpandPanel, useMessageExpandRender } from '../messageExpand'

// ============================================
// ToolPartView - 单个工具调用
// ============================================

interface ToolPartViewProps {
  execution: PiToolExecution
  /** Stable key for expand-state persistence (entry id + block index) */
  partKey: string
  isFirst?: boolean
  isLast?: boolean
  /** Compact layout: icon inline with text (14px column), no timeline connectors.
   *  Used for single-tool groups to align with ReasoningPartView. */
  compact?: boolean
  /** Descriptive steps mode: no icon/timeline, flat rows aligned with step summary. */
  descriptive?: boolean
  /** Parent assistant message is still streaming. */
  isStreaming?: boolean
  /** Call start time for the running-duration label (entry timestamp) */
  startedAt?: number
  /** 初始即展开（用户发起的 bash 等：发命令就是为了看输出）。仅影响初始
   *  状态；用户手动折叠后保持折叠（respectUser）。 */
  defaultExpanded?: boolean
}

export const ToolPartView = memo(function ToolPartView({
  execution,
  partKey,
  isFirst = false,
  isLast = false,
  compact = false,
  descriptive = false,
  isStreaming = false,
  startedAt,
  defaultExpanded = false,
}: ToolPartViewProps) {
  const { t } = useTranslation('message')
  const { call, result } = execution
  const toolName = call.name
  const status = result ? (result.isError ? 'error' : 'completed') : 'pending'
  const title = toolName || getInputDescription(execution) || ''

  const isActive = status === 'pending'
  const isError = status === 'error'
  const now = useNow(250, isActive)
  const startTime = startedAt
  const calibratedNow = isActive ? serverStore.getActiveCalibratedNow() : undefined
  const endTime = result?.timestamp ?? (isActive ? (calibratedNow ?? now) : undefined)
  const rawDuration = startTime !== undefined && endTime !== undefined ? endTime - startTime : undefined
  const duration = rawDuration !== undefined && isActive ? Math.max(0, rawDuration) : rawDuration
  const { immersiveMode } = useTheme()
  const isReadable = isReadableTool(toolName)
  const shouldStartExpanded =
    defaultExpanded || isActive || (immersiveMode && descriptive && isStreaming && isReadable)

  const [expanded, setExpanded] = useUiDisclosureState(`message:${partKey}`, shouldStartExpanded)
  const hasAutoExpandedReadableRef = useRef(shouldStartExpanded && immersiveMode && descriptive && isReadable)
  const [isChildFullscreen, setIsChildFullscreen] = useState(false)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const effectiveExpanded = expanded || isChildFullscreen
  // Android expand: instant layout + max-height fake; collapse: original grid-rows.
  const { contentRef: expandContentRef, layoutOpen, keepMounted, panelClassName } =
    useCompositorExpand(effectiveExpanded)
  // 展开即挂 body：默认展开的工具 header/body 同帧，不再先 header 后 body
  const shouldRenderBody = useMessageExpandRender(keepMounted)
  const toggleExpanded = useCallback(() => {
    withScrollLock(() => setExpanded(!expanded))
  }, [expanded, setExpanded, withScrollLock])

  useEffect(() => {
    let frameId: number | null = null

    if (isActive) {
      if (immersiveMode && descriptive && isReadable) {
        hasAutoExpandedReadableRef.current = true
      }
      frameId = requestAnimationFrame(() => {
        setExpanded(true, { touched: false, respectUser: true })
      })
    } else if (immersiveMode && descriptive && !isReadable) {
      frameId = requestAnimationFrame(() => {
        setExpanded(false, { touched: false, respectUser: true })
      })
    } else if (immersiveMode && descriptive && isStreaming && isReadable && !hasAutoExpandedReadableRef.current) {
      hasAutoExpandedReadableRef.current = true
      frameId = requestAnimationFrame(() => {
        setExpanded(true, { touched: false, respectUser: true })
      })
    }

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
    }
  }, [
    isActive,
    immersiveMode,
    descriptive,
    isStreaming,
    isReadable,
    setExpanded,
  ])

  // Shared icon element
  const toolIcon = (
    <div
      className={`
      relative flex items-center justify-center transition-colors duration-200
      ${isActive ? 'text-text-300' : ''}
      ${isError ? 'text-danger-100' : ''}
      ${status === 'completed' ? 'text-text-400 group-hover:text-text-300' : ''}
    `}
    >
      {getToolIcon(toolName)}
    </div>
  )

  // Memoize once — shared by both the descriptive header (diffStats) and ToolBody.
  const toolData = useMemo(() => extractToolData(execution), [execution])

  const handleFullscreenChange = useCallback((isFullscreen: boolean) => {
    setIsChildFullscreen(isFullscreen)
  }, [])

  const bodyContent = (
    <>
      <ToolBody execution={execution} partKey={partKey} data={toolData} onFullscreenChange={handleFullscreenChange} />
    </>
  )

  const expandBody = (padClass: string) => (
    <MessageExpandPanel
      open={layoutOpen}
      panelClassName={panelClassName}
      contentRef={expandContentRef}
      innerClassName="overflow-hidden min-h-0"
      contentClassName={padClass}
    >
      {shouldRenderBody && bodyContent}
    </MessageExpandPanel>
  )

  if (descriptive) {
    const hasDiffFiles = !!toolData.files?.length
    // diffStats 可能从 metadata 来，也可能需要从 diff 数据计算
    const diffStats = toolData.diffStats || computeDiffStatsFromData(toolData)

    return (
      <div ref={rootRef} className={`group ${MSG_SPACING.item}`}>
        <button
          type="button"
          ref={headerRef}
          className={`flex w-full items-center gap-3 rounded-md px-0 ${MSG_SPACING.header} text-left hover:bg-bg-200/30 transition-colors group/header`}
          onClick={toggleExpanded}
        >
          <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
            <span
              className={`shrink-0 font-medium text-[length:var(--fs-md)] leading-tight ${
                isActive
                  ? 'reasoning-shimmer-text'
                  : isError
                    ? 'text-danger-100'
                    : 'text-text-200 group-hover/header:text-text-100'
              }`}
            >
              {formatToolName(toolName)}
            </span>

            {title && (
              <span
                className={`min-w-0 truncate font-mono text-[length:var(--fs-code)] ${
                  isActive ? 'reasoning-shimmer-text' : isError ? 'text-danger-100/80' : 'text-text-400'
                }`}
              >
                {title}
              </span>
            )}

            {/* Diff stats — 紧跟 title，收起时且非失败时显示 */}
            {!effectiveExpanded && !isActive && !isError && (diffStats || hasDiffFiles) && (
              <span className="shrink-0 flex items-center gap-1 text-[length:var(--fs-xxs)] font-mono font-medium tabular-nums">
                {(diffStats?.additions ?? 0) > 0 && <span className="text-success-100">+{diffStats!.additions}</span>}
                {(diffStats?.deletions ?? 0) > 0 && <span className="text-danger-100">-{diffStats!.deletions}</span>}
              </span>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {duration !== undefined && (status === 'completed' || isActive) && (
              <span
                className={`text-[length:var(--fs-xxs)] font-mono tabular-nums ${isError ? 'text-danger-100/70' : isActive ? 'reasoning-shimmer-text' : 'text-text-500'}`}
              >
                {formatDuration(duration)}
              </span>
            )}
          </div>
        </button>

        {expandBody(MSG_SPACING.body)}
      </div>
    )
  }

  // ── Compact layout (single-tool, no timeline) ──
  // Grid: [14px icon] [gap 6px] [content] — mirrors ReasoningPartView alignment
  if (compact) {
    return (
      <div ref={rootRef} className={`group relative grid grid-cols-[14px_minmax(0,1fr)] gap-x-1.5 items-start ${MSG_SPACING.item}`}>
        {/* Icon column — fixed, outside of interactive area */}
        <span className="inline-flex h-9 w-[14px] items-center justify-center shrink-0">{toolIcon}</span>

        {/* Content column */}
        <div className="min-w-0">
          <button
            type="button"
            ref={headerRef}
            className="flex items-center gap-2 w-full h-9 text-left pl-2 pr-0 hover:bg-bg-200/40 rounded-sm transition-colors group/header"
            onClick={toggleExpanded}
          >
            <div className="flex items-baseline gap-2 overflow-hidden flex-1 min-w-0">
              <span
                className={`font-medium text-[length:var(--fs-md)] leading-tight transition-colors duration-300 shrink-0 ${
                  isActive
                    ? 'reasoning-shimmer-text'
                    : isError
                      ? 'text-danger-100'
                      : 'text-text-200 group-hover/header:text-text-100'
                }`}
              >
                {formatToolName(toolName)}
              </span>
              {title && (
                <span
                  className={`text-[length:var(--fs-sm)] truncate min-w-0 flex-1 font-mono ${
                    isActive ? 'reasoning-shimmer-text' : 'text-text-400 opacity-70'
                  }`}
                >
                  {title}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 ml-auto shrink-0">
              {duration !== undefined && (status === 'completed' || isActive) && (
                <span
                  className={`text-[length:var(--fs-xxs)] font-mono tabular-nums ${
                    isActive ? 'reasoning-shimmer-text' : 'text-text-500'
                  }`}
                >
                  {formatDuration(duration)}
                </span>
              )}
              <span
                className={`text-[length:var(--fs-xxs)] font-medium transition-all duration-300 ${
                  isActive ? 'opacity-100 text-text-400' : 'opacity-0 w-0 overflow-hidden'
                }`}
              >
                {t('toolPart.running')}
              </span>
              <span
                className={`text-[length:var(--fs-xxs)] font-medium transition-all duration-300 ${
                  isError ? 'opacity-100 text-danger-100' : 'opacity-0 w-0 overflow-hidden'
                }`}
              >
                {t('toolPart.failed')}
              </span>
              <span className="text-text-500">
                {effectiveExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
              </span>
            </div>
          </button>

          {expandBody(MSG_SPACING.toolBodyInset)}
        </div>
      </div>
    )
  }

  // ── Timeline layout (multi-tool groups) ──
  // 根节点不加垂直 padding，连接线要贴 icon
  return (
    <div ref={rootRef} className="group relative flex min-w-0">
      {/* Timeline Column */}
      <div className="w-8 shrink-0 relative">
        {/* Top connector — 留 4px gap 到 icon */}
        {!isFirst && <div className="absolute left-1/2 -translate-x-1/2 top-0 h-[7px] w-px bg-border-300/40" />}

        {/* Tool icon — h-9 和右侧 header 等高，flex 自然居中 */}
        <div className="h-9 flex items-center justify-center relative z-10">{toolIcon}</div>

        {/* Bottom connector — 留 4px gap 到 icon */}
        {!isLast && <div className="absolute left-1/2 -translate-x-1/2 top-[29px] bottom-0 w-px bg-border-300/40" />}
      </div>

      {/* Content Column */}
      <div className="flex-1 min-w-0">
        {/* Header - h-9 和 timeline 图标行等高 */}
        <button
          type="button"
          ref={headerRef}
          className="flex items-center gap-2.5 w-full h-9 text-left pl-2 pr-0 hover:bg-bg-200/40 rounded-sm transition-colors group/header"
          onClick={toggleExpanded}
        >
          <div className="flex items-baseline gap-2 overflow-hidden flex-1 min-w-0">
            <span
              className={`font-medium text-[length:var(--fs-md)] leading-tight transition-colors duration-300 shrink-0 ${
                isActive
                  ? 'reasoning-shimmer-text'
                  : isError
                    ? 'text-danger-100'
                    : 'text-text-200 group-hover/header:text-text-100'
              }`}
            >
              {formatToolName(toolName)}
            </span>

            {title && (
              <span
                className={`text-[length:var(--fs-sm)] truncate min-w-0 flex-1 font-mono ${
                  isActive ? 'reasoning-shimmer-text' : 'text-text-400 opacity-70'
                }`}
              >
                {title}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 ml-auto shrink-0">
            {duration !== undefined && (status === 'completed' || isActive) && (
              <span
                className={`text-[length:var(--fs-xxs)] font-mono tabular-nums transition-opacity duration-300 ${
                  isActive ? 'reasoning-shimmer-text' : 'text-text-500'
                }`}
              >
                {formatDuration(duration)}
              </span>
            )}
            <span
              className={`text-[length:var(--fs-xxs)] font-medium transition-all duration-300 ${
                isActive ? 'opacity-100 text-text-400' : 'opacity-0 w-0 overflow-hidden'
              }`}
            >
              {t('toolPart.running')}
            </span>
            <span
              className={`text-[length:var(--fs-xxs)] font-medium transition-all duration-300 ${
                isError ? 'opacity-100 text-danger-100' : 'opacity-0 w-0 overflow-hidden'
              }`}
            >
              {t('toolPart.failed')}
            </span>
            <span className="text-text-500">
              {effectiveExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            </span>
          </div>
        </button>

        {expandBody(MSG_SPACING.toolBodyInset)}
      </div>
    </div>
  )
})

// ============================================
// Helpers
// ============================================

/** 用户需要阅读/交互的工具 */
const READABLE_TOOL_PATTERNS = /bash|\bsh\b|cmd|terminal|shell|write|save|edit|replace|patch|todo|question|ask/i

function isReadableTool(toolName: string): boolean {
  return READABLE_TOOL_PATTERNS.test(toolName.toLowerCase())
}

/** 从 diff 数据计算 diffStats（当 metadata 没给 diffStats 时用） */
function computeDiffStatsFromData(data: {
  diff?: { before: string; after: string } | string
  files?: Array<{ before?: string; after?: string; additions?: number; deletions?: number }>
}): { additions: number; deletions: number } | undefined {
  // 多文件
  if (data.files?.length) {
    let additions = 0,
      deletions = 0
    for (const f of data.files) {
      if (f.additions !== undefined) additions += f.additions
      if (f.deletions !== undefined) deletions += f.deletions
      if (f.additions === undefined && f.before !== undefined && f.after !== undefined) {
        const s = computeDiffPair(f.before, f.after)
        additions += s.additions
        deletions += s.deletions
      }
    }
    return additions || deletions ? { additions, deletions } : undefined
  }

  // 单个 diff
  if (data.diff && typeof data.diff === 'object') {
    const s = computeDiffPair(data.diff.before, data.diff.after)
    return s.additions || s.deletions ? s : undefined
  }

  return undefined
}

function computeDiffPair(before: string, after: string): { additions: number; deletions: number } {
  const changes = diffLines(before, after)
  let additions = 0,
    deletions = 0
  for (const c of changes) {
    if (c.added) additions += c.count || 0
    if (c.removed) deletions += c.count || 0
  }
  return { additions, deletions }
}

// ============================================
// ToolBody - 根据工具类型选择渲染器
// ============================================

const ToolBody = memo(function ToolBody({
  execution,
  partKey,
  data,
  onFullscreenChange,
}: {
  execution: PiToolExecution
  partKey: string
  data: ReturnType<typeof extractToolData>
  onFullscreenChange?: (isFullscreen: boolean) => void
}) {
  const tool = execution.call.name
  const lowerTool = tool.toLowerCase()

  if (lowerTool === 'task') {
    return <TaskRenderer execution={execution} partKey={partKey} data={data} onFullscreenChange={onFullscreenChange} />
  }

  if (lowerTool.includes('todo') && hasTodos(execution)) {
    return <TodoRenderer execution={execution} partKey={partKey} data={data} onFullscreenChange={onFullscreenChange} />
  }

  const config = getToolConfig(tool)
  if (config?.renderer) {
    const CustomRenderer = config.renderer
    return <CustomRenderer execution={execution} partKey={partKey} data={data} onFullscreenChange={onFullscreenChange} />
  }

  return <DefaultRenderer execution={execution} partKey={partKey} data={data} onFullscreenChange={onFullscreenChange} />
})

/** Extract description from tool input as title fallback (available while running) */
function getInputDescription(execution: PiToolExecution): string | undefined {
  const input = execution.call.arguments as Record<string, unknown> | undefined
  return (input?.description as string) || undefined
}

// ============================================
// Helpers
// ============================================
