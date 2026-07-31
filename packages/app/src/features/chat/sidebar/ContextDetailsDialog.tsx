import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../../components/ui'
import { CodeBlock } from '../../../components/CodeBlock'
import { ChevronDownIcon, ChevronUpIcon, CpuIcon, DollarSignIcon } from '../../../components/Icons'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { SessionEntry } from '../../../pi/domain'
import { useFocusedSessionId, usePiBranchData } from '../../../pi/hooks/index.js'
import { useSessionStats, formatTokens, formatCost } from '../../../hooks'

interface ContextDetailsDialogProps {
  isOpen: boolean
  onClose: () => void
  contextLimit: number
}

type MessageEntry = Extract<SessionEntry, { type: 'message' }>

function isMessageEntry(entry: SessionEntry): entry is MessageEntry {
  return entry.type === 'message'
}

function isAssistantMessage(message: MessageEntry['message']): message is AssistantMessage {
  return message.role === 'assistant'
}

function usageTotal(usage: AssistantMessage['usage']): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

function formatTimestamp(timestamp: number | undefined): string {
  if (!timestamp) return '—'
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[length:var(--fs-xs)] font-medium text-text-400">{label}</div>
      <div className="text-[length:var(--fs-base)] text-text-200 font-mono truncate" title={value}>
        {value}
      </div>
    </div>
  )
}

export function ContextDetailsDialog({ isOpen, onClose, contextLimit }: ContextDetailsDialogProps) {
  const { t } = useTranslation(['chat', 'common'])

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('contextDetails.context')} width={900} className="w-full">
      {/* 关闭时不挂 body，避免流式时空转 */}
      {isOpen ? <ContextDetailsBody contextLimit={contextLimit} /> : null}
    </Dialog>
  )
}

function ContextDetailsBody({ contextLimit }: { contextLimit: number }) {
  const { t } = useTranslation(['chat', 'common'])
  const sessionId = useFocusedSessionId()
  const branch = usePiBranchData(sessionId)
  const stats = useSessionStats(contextLimit)

  const [expandedId, setExpandedId] = useState<string | null>(null)

  const messageEntries = useMemo(
    () => (branch?.items ?? []).filter(isMessageEntry).filter(e => e.message.role === 'user' || e.message.role === 'assistant'),
    [branch],
  )

  const lastAssistantWithTokens = useMemo(() => {
    for (let i = messageEntries.length - 1; i >= 0; i--) {
      const entry = messageEntries[i]
      if (!isAssistantMessage(entry.message)) continue
      if (usageTotal(entry.message.usage) <= 0) continue
      return entry as MessageEntry & { message: AssistantMessage }
    }
    return undefined
  }, [messageEntries])

  const counts = useMemo(() => {
    let user = 0
    let assistant = 0
    for (const e of messageEntries) {
      if (e.message.role === 'user') user++
      else assistant++
    }
    return { all: messageEntries.length, user, assistant }
  }, [messageEntries])

  const contextUsagePercent = useMemo(() => {
    if (stats.contextUsed <= 0 || contextLimit <= 0) return null
    return Math.round(stats.contextPercent)
  }, [stats.contextUsed, stats.contextPercent, contextLimit])

  const contextUsage = lastAssistantWithTokens?.message.usage

  const handleToggle = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id))
  }, [])

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Stat label={t('contextDetails.session')} value={sessionId || '—'} />
          <Stat
            label={t('contextDetails.messages')}
            value={`${counts.all} (user ${counts.user}, assistant ${counts.assistant})`}
          />
          <Stat
            label={t('contextDetails.provider')}
            value={lastAssistantWithTokens?.message.provider ?? '—'}
          />
          <Stat
            label={t('contextDetails.model')}
            value={lastAssistantWithTokens?.message.model ?? '—'}
          />
          <Stat label={t('contextDetails.contextLimit')} value={formatTokens(contextLimit)} />
          <Stat label={t('contextDetails.totalTokens')} value={stats.contextUsed ? formatTokens(stats.contextUsed) : '—'} />
          <Stat
            label={t('contextDetails.usage')}
            value={
              contextUsagePercent === null
                ? '—'
                : stats.contextEstimated
                  ? `${contextUsagePercent}% (estimated)`
                  : `${contextUsagePercent}%`
            }
          />
          <Stat label={t('contextDetails.totalCost')} value={formatCost(stats.totalCost)} />
        </div>

        {contextUsage && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 rounded-lg border border-border-200/50 bg-bg-200/20">
            <Stat label={t('contextDetails.inputTokens')} value={formatTokens(contextUsage.input)} />
            <Stat label={t('contextDetails.outputTokens')} value={formatTokens(contextUsage.output)} />
            <Stat
              label={t('contextDetails.cacheRW')}
              value={`${formatTokens(contextUsage.cacheRead)} / ${formatTokens(contextUsage.cacheWrite)}`}
            />
            <Stat label={t('contextDetails.totalCost')} value={formatCost(lastAssistantWithTokens!.message.usage.cost.total)} />
          </div>
        )}

        {lastAssistantWithTokens && (
          <div className="flex items-center justify-between text-[length:var(--fs-xs)] text-text-400">
            <div className="flex items-center gap-2">
              <CpuIcon size={14} className="opacity-60" />
              <span className="font-mono">last: {lastAssistantWithTokens.id}</span>
            </div>
            <span className="tabular-nums">{formatTimestamp(lastAssistantWithTokens.message.timestamp)}</span>
          </div>
        )}
      </div>

      <div className="mt-6">
        <div className="text-[length:var(--fs-xs)] font-medium text-text-400 mb-2">{t('contextDetails.rawMessages')}</div>
        <div className="space-y-1">
          {messageEntries.map(entry => {
            const message = entry.message
            const isExpanded = expandedId === entry.id

            const headerLabel = `${message.role} • ${entry.id}`
            const time = formatTimestamp(message.timestamp)

            const assistantTokens = isAssistantMessage(message) ? usageTotal(message.usage) : null
            const assistantCost = isAssistantMessage(message) ? message.usage.cost.total : null

            return (
              <div key={entry.id} className="rounded-lg border border-border-200/50 overflow-hidden">
                <button
                  type="button"
                  onClick={() => handleToggle(entry.id)}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left bg-bg-100 hover:bg-bg-200/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-[length:var(--fs-sm)] text-text-200 font-mono truncate" title={headerLabel}>
                      {headerLabel}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[length:var(--fs-xxs)] text-text-500 font-mono">
                      <span className="tabular-nums">{time}</span>
                      {assistantTokens !== null && (
                        <>
                          <span className="opacity-30">·</span>
                          <span className="flex items-center gap-1">
                            <CpuIcon size={10} className="opacity-60" />
                            {formatTokens(assistantTokens)}
                          </span>
                        </>
                      )}
                      {assistantCost !== null && assistantCost > 0 && (
                        <>
                          <span className="opacity-30">·</span>
                          <span className="flex items-center gap-1">
                            <DollarSignIcon size={10} className="opacity-60" />
                            {formatCost(assistantCost)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center gap-2 text-text-400">
                    {isExpanded ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
                  </div>
                </button>

                {isExpanded && (
                  <div className="p-3 bg-bg-000 border-t border-border-200/50">
                    <CodeBlock
                      code={JSON.stringify(entry, null, 2)}
                      language="json"
                      maxHeight={420}
                      className="select-text"
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
