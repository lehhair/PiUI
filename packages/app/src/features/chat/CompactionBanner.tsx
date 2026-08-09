// ============================================
// CompactionBanner — 压缩进行中的指示 + 取消
// ============================================
// SDK 没有压缩进度流，只有 compaction_start/end 事件；worker state 里
// compaction.operation.phase 在压缩期间为 "running"。这里照 Pi TUI 的
// CompactionStatusIndicator 显示一个 spinner + 文案 + 取消按钮（对应 TUI
// 的中断键），避免 /compact 之后只能干等。

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { JsonObject } from '@piui/protocol'
import { CloseIcon, SpinnerIcon } from '../../components/Icons'
import { abortPiCompaction } from '../../pi/controllers/index.js'

interface CompactionBannerProps {
  state: JsonObject | null | undefined
  sessionId: string | null
}

export const CompactionBanner = memo(function CompactionBanner({ state, sessionId }: CompactionBannerProps) {
  const { t } = useTranslation(['chat'])
  const compaction = state?.compaction
  const operation = compaction && typeof compaction === 'object'
    ? (compaction as { operation?: { phase?: string; reason?: string } }).operation
    : undefined
  // 顶层 isCompacting 与 compaction.operation.phase 双保险（压缩瞬间/旧版本
  // worker 可能只更新其中一个）
  const compacting = state?.isCompacting === true || operation?.phase === 'running'
  if (!compacting || !sessionId) return null

  const reason = operation?.reason
  const label = reason === 'manual'
    ? t('chat.compactingManual')
    : reason === 'overflow'
      ? t('chat.compactingOverflow')
      : t('chat.compactingAuto')

  return (
    <div className="mx-auto max-w-3xl px-3.5 pb-2">
      <div className="flex items-center gap-2 rounded-xl border border-border-200/60 bg-bg-100 px-3.5 py-2 shadow-float">
        <SpinnerIcon className="shrink-0 animate-spin text-accent-main-100" size={14} />
        <span className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)] text-text-200">{label}</span>
        <button
          type="button"
          onClick={() => void abortPiCompaction(sessionId).catch(() => undefined)}
          className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[length:var(--fs-xs)] text-text-400 hover:text-danger-100 hover:bg-bg-200/60 transition-colors"
        >
          <CloseIcon size={12} />
          {t('chat.compactingCancel')}
        </button>
      </div>
    </div>
  )
})
