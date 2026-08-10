import { useTranslation } from 'react-i18next'
import type { ActiveSessionEntry } from '../../../store/activeSessionStore'
import { startInternalDrag } from '../../../lib/internalDragCore'

interface ActiveSessionItemProps {
  entry: ActiveSessionEntry
  isSelected: boolean
  onSelect: (session: { id: string; directory?: string }) => void
}

export function ActiveSessionItem({ entry, isSelected, onSelect }: ActiveSessionItemProps) {
  const { t } = useTranslation(['chat', 'common'])
  const isRetry = entry.status.type === 'retry'
  const pending = entry.pendingAction
  // 活跃 session 元信息由全局同步提供：SessionContext 始终拉全局列表并
  // syncPiSummaries 到 activeSessionStore，因此 entry.title/directory 对
  // 任意工作区的活跃 session 都是完整的，无需再依赖列表解析。
  const displayTitle = entry.title || entry.sessionId.slice(0, 12) + '...'
  const directory = entry.directory

  // 状态显示：permission > question > retry > working
  const statusConfig =
    pending?.type === 'permission'
      ? {
          label: t('activeSession.awaitingPermission'),
          color: 'text-warning-100',
          dotColor: 'bg-warning-100',
          pulse: false,
        }
      : pending?.type === 'question'
        ? { label: t('activeSession.awaitingAnswer'), color: 'text-info-100', dotColor: 'bg-info-100', pulse: false }
        : isRetry
          ? { label: t('activeSession.retrying'), color: 'text-warning-100', dotColor: 'bg-warning-100', pulse: false }
          : { label: t('activeSession.working'), color: 'text-success-100', dotColor: 'bg-success-100', pulse: true }

  const handleClick = () => {
    onSelect({ id: entry.sessionId, directory })
  }

  // 拖拽到主信息流进行分屏 / 替换会话
  const isDraggable = Boolean(directory)
  const handlePointerDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggable) return
    startInternalDrag(
      e,
      {
        kind: 'session',
        sessionId: entry.sessionId,
        directory,
      },
    )
  }

  return (
    <div
      onPointerDown={handlePointerDragStart}
      onClick={handleClick}
      className={`group relative flex items-start pl-[6px] pr-3 py-2 rounded-lg cursor-pointer select-none transition-all duration-200 border border-transparent ${
        isSelected ? 'bg-bg-000 shadow-sm ring-1 ring-border-200/50' : 'hover:bg-bg-200/50'
      }`}
    >
      {/* Content */}
      <div className="flex-1 min-w-0 pr-1">
        <p
          className={`text-[length:var(--fs-md)] truncate font-medium ${
            isSelected ? 'text-text-100' : 'text-text-200 group-hover:text-text-100'
          }`}
          title={displayTitle}
        >
          {displayTitle}
        </p>
        <div className="mt-1 flex h-4 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[length:var(--fs-xxs)] text-text-400">
          <span className="relative shrink-0 flex h-3 w-3 items-center justify-center">
            <span className={`absolute h-1.5 w-1.5 rounded-full ${statusConfig.dotColor}`} />
            {statusConfig.pulse && (
              <span className={`absolute h-1.5 w-1.5 rounded-full ${statusConfig.dotColor} animate-ping opacity-50`} />
            )}
          </span>
          <span className="opacity-30 shrink-0">·</span>
          <span className={`shrink-0 whitespace-nowrap ${statusConfig.color}`}>{statusConfig.label}</span>
          {pending?.description && (
            <>
              <span className="opacity-30 shrink-0">·</span>
              <span className="truncate min-w-0 flex-1 opacity-60">{pending.description}</span>
            </>
          )}
          {isRetry && entry.status.type === 'retry' && (
            <>
              <span className="opacity-30 shrink-0">·</span>
              <span className="text-text-400 opacity-60 shrink-0 whitespace-nowrap">
                {t('activeSession.attempt', { count: entry.status.attempt })}
              </span>
            </>
          )}
          {directory && (
            <>
              <span className="opacity-30 shrink-0">·</span>
              <span className="truncate min-w-0 flex-1 opacity-50" title={directory}>
                {directory.replace(/\\/g, '/').split('/').filter(Boolean).pop()}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
