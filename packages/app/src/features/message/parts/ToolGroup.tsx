import { memo, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { diffLines } from 'diff'
import { ChevronDownIcon, ChevronRightIcon } from '../../../components/Icons'
import type { PiToolExecution } from '../../../pi/domain/index.js'
import { useCompositorExpand, useDisclosureScrollLock } from '../../../hooks'
import { useTheme } from '../../../hooks/useTheme'
import { extractToolData } from '../tools'
import { useUiDisclosureState } from '../../../utils/uiDisclosureState'
import { MessageExpandPanel, useMessageExpandRender } from '../messageExpand'
import { MSG_SPACING } from '../messageSpacing'
import { ToolPartView } from './ToolPartView'

// ============================================
// Tool Group (连续的 tool parts)
// 同时服务于 assistant 消息内的工具组（AI 调用）和用户 `!cmd`/`/bash`
// 发起的 bash 执行组——两者渲染完全一致。
// ============================================

interface ToolGroupProps {
  /** 稳定分组 id：assistant 消息用 entryId，bash 组用组内第一个 entryId */
  groupId: string
  startedAt?: number
  executions: PiToolExecution[]
  isStreaming?: boolean
  modelLabel?: string
  /** 组内工具初始即展开（用户发起的 bash：发命令就是为了看输出）。
   *  仅影响初始状态；用户手动折叠后保持折叠（respectUser）。 */
  defaultExpanded?: boolean
}

/** 用户需要阅读/交互的工具：沉浸模式下这些工具完成后保持展开 */
const READABLE_TOOL_PATTERNS = /bash|\bsh\b|cmd|terminal|shell|write|save|edit|replace|patch|todo|question|ask/i

function isReadableTool(toolName: string): boolean {
  return READABLE_TOOL_PATTERNS.test(toolName.toLowerCase())
}

export const ToolGroup = memo(function ToolGroup({
  groupId,
  startedAt,
  executions,
  isStreaming,
  modelLabel,
  defaultExpanded = false,
}: ToolGroupProps) {
  const { t } = useTranslation('message')
  const { descriptiveToolSteps, immersiveMode, processCollapseEnabled } = useTheme()

  const doneCount = executions.filter(e => e.result && !e.result.isError).length
  const totalCount = executions.length
  const isAllDone = doneCount === totalCount
  const hasActiveTools = executions.some(e => !e.result)
  const stepsSummary = descriptiveToolSteps ? buildDescriptiveToolStepsSummary(executions, t) : undefined

  // 汇总所有成功完成的工具的 diff stats（失败的不算）
  const totalDiffStats = useMemo(() => {
    if (!descriptiveToolSteps) return undefined
    let additions = 0,
      deletions = 0
    for (const execution of executions) {
      if (execution.result?.isError) continue
      const data = extractToolData(execution)
      const stats = data.diffStats || computePartDiffStats(data)
      if (stats) {
        additions += stats.additions
        deletions += stats.deletions
      }
    }
    return additions || deletions ? { additions, deletions } : undefined
  }, [descriptiveToolSteps, executions])

  // 沉浸模式下：判断工具组是否包含需要用户阅读的工具
  const hasReadableTools = immersiveMode && executions.some(e => isReadableTool(e.call.name))
  // 过程折叠：steps 默认收起；其它模式：活跃/流式/可读工具时展开。
  // defaultExpanded（用户发起的 bash）优先于一切，直接展开。
  const shouldStartExpanded = defaultExpanded
    ? true
    : processCollapseEnabled
      ? false
      : !descriptiveToolSteps ||
        hasActiveTools ||
        (immersiveMode && !!isStreaming && hasReadableTools)

  const groupStateKey = `message:${groupId}:tool-group:${executions[0]?.call.id ?? 'empty'}`
  const [expanded, setExpanded] = useUiDisclosureState(groupStateKey, shouldStartExpanded)
  const hasAutoExpandedReadableRef = useRef(
    !processCollapseEnabled && shouldStartExpanded && immersiveMode && hasReadableTools,
  )
  const { rootRef: stepsRootRef, headerRef: stepsHeaderRef, withScrollLock: withStepsScrollLock } =
    useDisclosureScrollLock()

  useEffect(() => {
    // 用户发起的 bash：默认展开由初始状态保证，不参与自动展开/收起干预
    if (defaultExpanded) return
    if (!descriptiveToolSteps) return

    // 过程折叠：不因 active/streaming 自动展开 steps
    if (processCollapseEnabled) return

    // 沉浸模式下没有可读工具：始终收起
    if (immersiveMode && !hasReadableTools) {
      setExpanded(false, { touched: false, respectUser: true })
      return
    }
    if (hasActiveTools) {
      if (immersiveMode && hasReadableTools) {
        hasAutoExpandedReadableRef.current = true
      }
      setExpanded(true, { touched: false, respectUser: true })
      return
    }
    // 某些可读工具（如 todo）可能首帧已完成，错过 running 态；流仍在继续时也自动展开一次
    if (immersiveMode && isStreaming && hasReadableTools && !hasAutoExpandedReadableRef.current) {
      hasAutoExpandedReadableRef.current = true
      setExpanded(true, { touched: false, respectUser: true })
    }
  }, [
    descriptiveToolSteps,
    processCollapseEnabled,
    hasActiveTools,
    immersiveMode,
    hasReadableTools,
    isStreaming,
    setExpanded,
    defaultExpanded,
  ])

  const effectiveExpanded = expanded
  // Android expand: instant layout + max-height fake; collapse: original grid-rows.
  // Only animate at the steps shell level so nested ToolPartView does not double-animate.
  const {
    contentRef: stepsExpandContentRef,
    layoutOpen: stepsLayoutOpen,
    keepMounted: stepsKeepMounted,
    panelClassName: stepsPanelClassName,
  } = useCompositorExpand(effectiveExpanded)
  // 展开即挂工具行：默认展开时 header 与 body 同帧
  const shouldRenderBody = useMessageExpandRender(stepsKeepMounted)

  // compact: 单工具时用紧凑布局（图标内联，无 timeline 连接线）
  // 不区分 streaming 状态 — 单工具始终 compact，第二个工具到来时再自然过渡到 timeline
  const isSingleCompact = totalCount === 1 && !descriptiveToolSteps
  // steps header: 多工具始终显示；描述型 steps 模式下，单工具也显示
  const showStepsHeader = totalCount > 1 || descriptiveToolSteps

  // 只 map 一次：有 header 时受 expand mount 控制，无 header 时始终挂载
  const toolParts =
    !showStepsHeader || shouldRenderBody
      ? executions.map((execution, idx) => (
          <ToolPartView
            key={execution.call.id}
            execution={execution}
            partKey={`${groupId}:${execution.call.id}`}
            isFirst={idx === 0}
            isLast={idx === executions.length - 1}
            compact={isSingleCompact}
            descriptive={descriptiveToolSteps}
            isStreaming={isStreaming}
            startedAt={startedAt}
            defaultExpanded={defaultExpanded}
          />
        ))
      : null

  // 统一容器结构 — ToolPartView 始终在同一 React 树位置，
  // streaming→idle / 1→N 工具切换时不 remount，expanded 状态不丢失
  return (
    <div ref={stepsRootRef} className="flex flex-col">
      {showStepsHeader &&
        (descriptiveToolSteps ? (
          <button
            type="button"
            ref={stepsHeaderRef}
            onClick={() => withStepsScrollLock(() => setExpanded(!expanded))}
            className={`flex w-full items-baseline rounded-md ${MSG_SPACING.header} text-left hover:bg-bg-200/30 transition-colors`}
          >
            <span className="text-[length:var(--fs-sm)] leading-5">
              {stepsSummary?.map((seg, i) => (
                <span
                  key={i}
                  className={
                    seg.type === 'error'
                      ? 'text-danger-100'
                      : seg.type === 'active'
                        ? 'reasoning-shimmer-text'
                        : 'text-text-300'
                  }
                >
                  {seg.text}
                </span>
              ))}
            </span>
            {totalDiffStats && !hasActiveTools && (
              <span className="ml-1.5 inline-flex items-center gap-1 text-[length:var(--fs-xxs)] font-mono font-medium tabular-nums">
                {totalDiffStats.additions > 0 && (
                  <span className="text-success-100">+{totalDiffStats.additions}</span>
                )}
                {totalDiffStats.deletions > 0 && <span className="text-danger-100">-{totalDiffStats.deletions}</span>}
              </span>
            )}
          </button>
        ) : (
          <button
            type="button"
            ref={stepsHeaderRef}
            onClick={() => withStepsScrollLock(() => setExpanded(!expanded))}
            className={`flex items-center gap-1.5 ${MSG_SPACING.header} text-text-400 text-[length:var(--fs-base)] hover:text-text-200 hover:bg-bg-200/30 rounded-md transition-colors`}
          >
            <span className="inline-flex w-[14px] items-center justify-center shrink-0">
              {effectiveExpanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
            </span>
            <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
              <span className="text-[length:var(--fs-md)] font-medium leading-tight">
                {isAllDone
                  ? t('stepsCount', { done: totalCount, total: totalCount })
                  : t('stepsCount', { done: doneCount, total: totalCount })}
              </span>
              {!effectiveExpanded && modelLabel && (
                <span className="text-[length:var(--fs-sm)] text-text-500 font-mono opacity-70">
                  {modelLabel}
                </span>
              )}
            </span>
          </button>
        ))}

      {showStepsHeader ? (
        <MessageExpandPanel
          open={stepsLayoutOpen}
          panelClassName={stepsPanelClassName}
          contentRef={stepsExpandContentRef}
          clip
          innerClassName="flex flex-col min-h-0 min-w-0 overflow-hidden"
        >
          {toolParts}
        </MessageExpandPanel>
      ) : (
        <div className="flex flex-col">{toolParts}</div>
      )}
    </div>
  )
})

// ============================================
// Helpers
// ============================================

type ToolSummaryCategory =
  | 'execute'
  | 'write'
  | 'edit'
  | 'read'
  | 'search'
  | 'list'
  | 'network'
  | 'task'
  | 'todo'
  | 'question'
  | 'skill'
  | 'think'
  | 'other'

type ToolSummaryPhase = 'done' | 'active' | 'failed'

interface SummarySegment {
  text: string
  type: 'normal' | 'error' | 'active'
}

function buildDescriptiveToolStepsSummary(
  executions: PiToolExecution[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): SummarySegment[] {
  const sep = t('toolSteps.separator')
  const segments: SummarySegment[] = []
  const MAX_CATEGORIES = 3

  // ── 按类别汇总 done / failed / active ──
  const categoryOrder: ToolSummaryCategory[] = []
  const doneMap = new Map<ToolSummaryCategory, number>()
  const failedMap = new Map<ToolSummaryCategory, number>()
  const activeMap = new Map<ToolSummaryCategory, number>()

  for (const execution of executions) {
    const cat = getToolSummaryCategory(execution.call.name)
    if (!doneMap.has(cat)) {
      categoryOrder.push(cat)
      doneMap.set(cat, 0)
      failedMap.set(cat, 0)
      activeMap.set(cat, 0)
    }
    if (execution.result && !execution.result.isError) doneMap.set(cat, (doneMap.get(cat) || 0) + 1)
    else if (execution.result?.isError) failedMap.set(cat, (failedMap.get(cat) || 0) + 1)
    else activeMap.set(cat, (activeMap.get(cat) || 0) + 1)
  }

  // ── 已完成 + 失败（合并同类别）──
  // 先收集所有完成态类别（含纯失败的类别）
  const finishedCategories = categoryOrder.filter(cat => (doneMap.get(cat) || 0) > 0 || (failedMap.get(cat) || 0) > 0)

  const pushFinishedSegments = (cats: ToolSummaryCategory[]) => {
    for (const cat of cats) {
      const done = doneMap.get(cat) || 0
      const failed = failedMap.get(cat) || 0
      if (segments.length > 0) segments.push({ text: sep, type: 'normal' })

      if (done > 0 && failed > 0) {
        // 同类别既有成功又有失败：合并成一句
        const total = done + failed
        segments.push({ text: formatToolSummarySegment(cat, total, 'done', t), type: 'normal' })
        segments.push({ text: t('toolSteps.failedSuffix', { count: failed }), type: 'error' })
      } else if (done > 0) {
        segments.push({ text: formatToolSummarySegment(cat, done, 'done', t), type: 'normal' })
      } else {
        // 纯失败
        if (failed === 1) {
          segments.push({ text: formatToolSummarySegment(cat, failed, 'failed', t), type: 'error' })
        } else {
          segments.push({ text: formatToolSummarySegment(cat, failed, 'done', t), type: 'error' })
          segments.push({ text: t('toolSteps.failedAllSuffix'), type: 'error' })
        }
      }
    }
  }

  if (finishedCategories.length <= MAX_CATEGORIES) {
    pushFinishedSegments(finishedCategories)
  } else {
    pushFinishedSegments(finishedCategories.slice(0, MAX_CATEGORIES))
    const restCount = finishedCategories
      .slice(MAX_CATEGORIES)
      .reduce((sum, cat) => sum + (doneMap.get(cat) || 0) + (failedMap.get(cat) || 0), 0)
    segments.push({ text: sep, type: 'normal' })
    segments.push({ text: t('toolSteps.moreActions', { count: restCount }), type: 'normal' })
  }

  // ── 运行中 ──
  const activeCategories = categoryOrder.filter(cat => (activeMap.get(cat) || 0) > 0)
  for (const cat of activeCategories) {
    if (segments.length > 0) segments.push({ text: sep, type: 'normal' })
    segments.push({ text: formatToolSummarySegment(cat, activeMap.get(cat) || 0, 'active', t), type: 'active' })
  }

  if (segments.length === 0) {
    return [{ text: t('stepsCount', { done: 0, total: executions.length }), type: 'normal' }]
  }

  let isFirstContent = true
  for (const seg of segments) {
    if (seg.text === sep) continue
    if (isFirstContent) {
      isFirstContent = false
      continue
    }
    seg.text = seg.text.charAt(0).toLowerCase() + seg.text.slice(1)
  }

  return segments
}

function formatToolSummarySegment(
  category: ToolSummaryCategory,
  count: number,
  phase: ToolSummaryPhase,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const key = `toolSteps.${category}${phase.charAt(0).toUpperCase()}${phase.slice(1)}`
  return t(key, { count })
}

function getToolSummaryCategory(toolName: string): ToolSummaryCategory {
  const lower = toolName.toLowerCase()

  if (lower.includes('todo')) return 'todo'
  if (lower === 'task') return 'task'
  if (lower.includes('question') || lower.includes('ask')) return 'question'
  if (lower.includes('skill')) return 'skill'
  if (
    lower.includes('bash') ||
    lower === 'sh' ||
    lower.includes('cmd') ||
    lower.includes('terminal') ||
    lower.includes('shell')
  ) {
    return 'execute'
  }
  if (lower.includes('write') || lower.includes('save')) {
    return 'write'
  }
  if (lower.includes('edit') || lower.includes('replace') || lower.includes('patch')) {
    return 'edit'
  }
  if (
    lower.includes('web') ||
    lower.includes('fetch') ||
    lower.includes('http') ||
    lower.includes('browse') ||
    lower.includes('network') ||
    lower.includes('exa')
  ) {
    return 'network'
  }
  if (lower.includes('read') || lower.includes('cat')) return 'read'
  if (lower.includes('grep') || lower.includes('search')) return 'search'
  if (lower.includes('glob') || lower.includes('find')) return 'list'
  if (lower.includes('think') || lower.includes('reason') || lower.includes('plan')) return 'think'
  return 'other'
}

/** 从 extractToolData 的结果计算 diff stats（当 metadata 没给 diffStats 时） */
function computePartDiffStats(data: {
  diff?: { before: string; after: string } | string
  files?: Array<{ before?: string; after?: string; additions?: number; deletions?: number }>
}): { additions: number; deletions: number } | undefined {
  if (data.files?.length) {
    let a = 0,
      d = 0
    for (const f of data.files) {
      if (f.additions !== undefined) a += f.additions
      if (f.deletions !== undefined) d += f.deletions
      if (f.additions === undefined && f.before !== undefined && f.after !== undefined) {
        const s = diffPairStats(f.before, f.after)
        a += s.additions
        d += s.deletions
      }
    }
    return a || d ? { additions: a, deletions: d } : undefined
  }
  if (data.diff && typeof data.diff === 'object') {
    const s = diffPairStats(data.diff.before, data.diff.after)
    return s.additions || s.deletions ? s : undefined
  }
  return undefined
}

function diffPairStats(before: string, after: string): { additions: number; deletions: number } {
  const changes = diffLines(before, after)
  let additions = 0,
    deletions = 0
  for (const c of changes) {
    if (c.added) additions += c.count || 0
    if (c.removed) deletions += c.count || 0
  }
  return { additions, deletions }
}
