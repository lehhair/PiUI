import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  PiBashExecutionGroupItem,
  PiBashExecutionItem,
  PiBranchSummaryItem,
  PiCompactionItem,
  PiCustomMessageItem,
  PiTimelineItem,
  PiToolExecution,
  PiUnknownItem,
} from '../../../pi/domain/index.js'
import { MarkdownRenderer } from '../../../components/MarkdownRenderer'
import { ChevronDownIcon } from '../../../components/Icons'
import { useUiDisclosureState } from '../../../utils/uiDisclosureState'
import { useDisclosureScrollLock } from '../../../hooks'
import { useNow } from '../../../hooks/useNow'
import { chevronClass, MessageExpandPanel, useMessageExpandRender } from '../messageExpand'
import { ToolGroup } from './ToolGroup'

// ============================================
// Pi system timeline item views
// Visual language follows CompactionPartView (divider + small label).
// ============================================

/**
 * Renders non-conversation timeline items (bash executions, compaction,
 * branch summaries, model/thinking changes, labels, custom messages,
 * unknown entries). Nothing is silently dropped — unknown kinds get a
 * visible divider with their entry type.
 */
export const PiSystemItemView = memo(function PiSystemItemView({ item }: { item: PiTimelineItem }) {
  switch (item.kind) {
    case 'bash_execution':
    case 'bash_execution_group':
      return <BashExecutionGroupView item={item} />
    case 'compaction':
      return <CompactionItemView item={item} />
    case 'branch_summary':
      return <BranchSummaryItemView item={item} />
    case 'custom_message':
      return item.display ? <CustomMessageItemView item={item} /> : null
    case 'unknown':
      return <UnknownItemView item={item} />
    default:
      return null
  }
})

// ============================================
// Divider row (CompactionPartView visual language)
// ============================================

interface DividerRowProps {
  partKey: string
  label: string
  detail?: string
}

const DividerRow = memo(function DividerRow({ partKey, label, detail }: DividerRowProps) {
  const hasDetail = Boolean(detail && detail.trim())
  const [expanded, setExpanded] = useUiDisclosureState(`pi:${partKey}:divider`, false)
  const shouldRenderBody = useMessageExpandRender(expanded)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()

  if (!hasDetail) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-[length:var(--fs-sm)] text-text-500">
        <span className="flex-1 h-px bg-border-200/70" />
        <span className="shrink-0 text-[length:var(--fs-xs)] leading-none text-text-400">{label}</span>
        <span className="flex-1 h-px bg-border-200/70" />
      </div>
    )
  }

  return (
    <div ref={rootRef}>
      <button
        type="button"
        ref={headerRef}
        onClick={() => withScrollLock(() => setExpanded(!expanded))}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[length:var(--fs-sm)] text-text-500 hover:text-text-400 transition-colors"
      >
        <span className="flex-1 h-px bg-border-200/70" />
        <span className="shrink-0 inline-flex items-center gap-1 text-[length:var(--fs-xs)] leading-none text-text-400">
          {label}
          <ChevronDownIcon size={10} className={chevronClass(expanded)} />
        </span>
        <span className="flex-1 h-px bg-border-200/70" />
      </button>
      <MessageExpandPanel open={expanded} variant="fade" innerClassName="overflow-hidden">
        {shouldRenderBody && detail && (
          <div className="px-3 pb-2">
            <MarkdownRenderer content={detail} variant="reasoning" />
          </div>
        )}
      </MessageExpandPanel>
    </div>
  )
})

// ============================================
// Item views
// ============================================

/**
 * 用户发起的 bash 执行（`!cmd` / `/bash cmd`）渲染。
 * 相邻执行由 selector 合并为 bash_execution_group；单个 bash 也走同一
 * 组件。复用 ToolGroup：与 AI 自己调用工具（连续工具组）的渲染完全一致
 * —— 单条 compact、多条 steps header + timeline。
 *
 * 展开策略：参考助手工具"进行中展开"——bash 刚执行完（最近
 * FRESH_BASH_WINDOW_MS 内落盘）视为活跃，默认展开（发命令就是为了看
 * 输出）；窗口过后 / 刷新回到 session 的历史条目恢复默认折叠。初始展开
 * 后由 useUiDisclosureState 保持，用户手动折叠会尊重。
 */
const FRESH_BASH_WINDOW_MS = 5 * 60_000

function BashExecutionGroupView({ item }: { item: PiBashExecutionItem | PiBashExecutionGroupItem }) {
  const items = 'items' in item ? item.items : [item]
  const executions: PiToolExecution[] = items.map(bashItemToExecution)
  // 组内最新一条的执行时间：组增长（连续发新命令并入）时按最新命令判定。
  // useNow 提供渲染安全的时间源（渲染期不得直接调 Date.now）。
  const latestTimestamp = items.reduce((max, bashItem) => Math.max(max, bashItem.timestamp), 0)
  const now = useNow(60_000)
  const fresh = latestTimestamp > 0 && now - latestTimestamp < FRESH_BASH_WINDOW_MS
  return (
    <ToolGroup
      groupId={item.entryId}
      startedAt={item.timestamp}
      executions={executions}
      defaultExpanded={fresh}
    />
  )
}

function bashItemToExecution(item: PiBashExecutionItem): PiToolExecution {
  const call: PiToolExecution['call'] = {
    type: 'toolCall',
    id: item.entryId,
    name: 'bash',
    arguments: { command: item.message.command },
  }
  // 乐观条目（执行中，无 exitCode）：result 缺失 → isActive，BashRenderer
  // 通过 useLiveToolOutput(call.id) 显示流式输出（pi TUI 的 onChunk 对应物）
  if (item.message.exitCode === undefined) {
    return { call }
  }
  return {
    call,
    result: {
      role: 'toolResult',
      toolCallId: item.entryId,
      toolName: 'bash',
      content: [{ type: 'text', text: item.message.output }],
      isError: item.message.exitCode !== 0,
      timestamp: item.message.timestamp,
    },
  }
}

function CompactionItemView({ item }: { item: PiCompactionItem }) {
  const { t } = useTranslation('message')
  return <DividerRow partKey={item.entryId} label={t('system.contextCompacted')} detail={item.summary} />
}

function BranchSummaryItemView({ item }: { item: PiBranchSummaryItem }) {
  const { t } = useTranslation('message')
  return <DividerRow partKey={item.entryId} label={t('system.branchSummary')} detail={item.summary} />
}

function CustomMessageItemView({ item }: { item: PiCustomMessageItem }) {
  const text = typeof item.content === 'string'
    ? item.content
    : item.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
  if (!text.trim()) return null
  return <MarkdownRenderer content={text} />
}

function UnknownItemView({ item }: { item: PiUnknownItem }) {
  const { t } = useTranslation('message')
  return <DividerRow partKey={item.entryId} label={t('system.unsupportedEntry', { type: item.entryType })} />
}
