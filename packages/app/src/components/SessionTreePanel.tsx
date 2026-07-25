import { memo, startTransition, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { PiSessionEntryV1, PiSessionTreeNodeV1 } from '@piui/protocol'
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  GitBranchIcon,
  PencilIcon,
  RetryIcon,
  StopIcon,
  TrashIcon,
  UploadIcon,
} from './Icons'
import { IconButton } from './ui/IconButton'
import { applySnapshotToUi } from '../pi/applySnapshot'
import { usePiCapabilities } from '../pi/capabilities'
import {
  abortPiBranchSummary,
  abortPiCompaction,
  abortPiRetry,
  clearPiQueue,
  clonePiSession,
  compactSession,
  forkPiSession,
  importPiSession,
  navigatePiSessionTree,
  setPiActiveTools,
  setPiAutoCompaction,
  setPiAutoRetry,
  setPiQueueModes,
  setPiSessionLabel,
  type SessionReplacementResponse,
} from '../pi/sessionApi'
import { clearSessionEditorDraft, setSessionEditorDraft } from '../pi/sessionEditorDraftStore'
import { sessionProjectionStore } from '../pi/sessionProjectionStore'

interface SessionTreePanelProps {
  sessionId: string
  onNavigateSession?: (session: { id: string; directory?: string }) => void
}

interface TreeNodeProps {
  node: PiSessionTreeNodeV1
  depth: number
  leafId: string | null
  pendingEntryId: string | null
  editingEntryId: string | null
  editingLabel: string
  canNavigate: boolean
  canFork: boolean
  canClone: boolean
  onNavigate: (entryId: string) => void
  onFork: (entryId: string) => void
  onClone: (entryId: string) => void
  onStartLabel: (entryId: string, label?: string) => void
  onEditingLabelChange: (label: string) => void
  onSubmitLabel: (entryId: string) => void
  onCancelLabel: () => void
}

function entryText(entry: PiSessionEntryV1, typeLabel: (type: string) => string): string {
  switch (entry.type) {
    case 'message':
      return entry.preview || entry.role
    case 'model_change':
      return `${entry.provider}/${entry.modelId}`
    case 'thinking_level_change':
      return entry.thinkingLevel
    case 'compaction':
      return entry.summary
    case 'branch_summary':
      return entry.summary
    case 'custom_message':
      return entry.preview || entry.customType
    case 'custom':
      return entry.customType
    case 'label':
      return entry.label || typeLabel(entry.type)
    case 'session_info':
      return entry.name || typeLabel(entry.type)
  }
}

const SessionTreeNode = memo(function SessionTreeNode({
  node,
  depth,
  leafId,
  pendingEntryId,
  editingEntryId,
  editingLabel,
  canNavigate,
  canFork,
  canClone,
  onNavigate,
  onFork,
  onClone,
  onStartLabel,
  onEditingLabelChange,
  onSubmitLabel,
  onCancelLabel,
}: TreeNodeProps) {
  const { t } = useTranslation('components')
  const entry = node.entry
  const isLeaf = entry.id === leafId
  const isPending = entry.id === pendingEntryId
  const isEditing = entry.id === editingEntryId
  const text = entryText(entry, type => t(`sessionTree.entryTypes.${type}`))

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-current={isLeaf ? 'true' : undefined}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '36px' }}
    >
      <div
        className={`group relative flex min-h-9 items-center border-b border-border-200/20 pr-2 ${
          isLeaf ? 'bg-accent-main-100/8' : 'hover:bg-bg-200/35'
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {depth > 0 ? (
          <span className="absolute bottom-0 top-0 w-px bg-border-200/35" style={{ left: `${depth * 16}px` }} />
        ) : null}
        <span
          className={`mr-2 h-2 w-2 shrink-0 rounded-full border ${
            isLeaf ? 'border-accent-main-100 bg-accent-main-100' : 'border-text-500 bg-bg-100'
          }`}
        />
        {isEditing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 py-1">
            <input
              autoFocus
              value={editingLabel}
              onChange={event => onEditingLabelChange(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') onSubmitLabel(entry.id)
                if (event.key === 'Escape') onCancelLabel()
              }}
              placeholder={t('sessionTree.labelPlaceholder')}
              className="h-7 min-w-0 flex-1 rounded border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100"
            />
            <IconButton
              aria-label={t('common:save')}
              title={t('common:save')}
              size="sm"
              onClick={() => onSubmitLabel(entry.id)}
            >
              <CheckIcon size={13} />
            </IconButton>
            <IconButton
              aria-label={t('sessionTree.cancel')}
              title={t('sessionTree.cancel')}
              size="sm"
              onClick={onCancelLabel}
            >
              <CloseIcon size={13} />
            </IconButton>
          </div>
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 py-2 text-left disabled:cursor-default"
            onClick={() => onNavigate(entry.id)}
            disabled={!canNavigate || isLeaf || isPending}
            title={isLeaf ? t('sessionTree.current') : t('sessionTree.navigate')}
          >
            <span className="block truncate text-[length:var(--fs-sm)] text-text-200">{node.label || text}</span>
            {node.label ? (
              <span className="block truncate text-[length:var(--fs-xs)] text-text-500">{text}</span>
            ) : null}
          </button>
        )}

        {!isEditing ? (
          <div className="flex shrink-0 items-center opacity-60 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            <IconButton
              aria-label={t('sessionTree.label')}
              title={t('sessionTree.label')}
              size="sm"
              disabled={isPending}
              onClick={() => onStartLabel(entry.id, node.label)}
            >
              <PencilIcon size={13} />
            </IconButton>
            {canFork ? (
              <IconButton
                aria-label={t('sessionTree.fork')}
                title={t('sessionTree.fork')}
                size="sm"
                disabled={isPending}
                onClick={() => onFork(entry.id)}
              >
                <GitBranchIcon size={13} />
              </IconButton>
            ) : null}
            {canClone ? (
              <IconButton
                aria-label={t('sessionTree.clone')}
                title={t('sessionTree.clone')}
                size="sm"
                disabled={isPending}
                onClick={() => onClone(entry.id)}
              >
                <CopyIcon size={13} />
              </IconButton>
            ) : null}
          </div>
        ) : null}
      </div>
      {node.children.length > 0 ? (
        <div role="group">
          {node.children.map(child => (
            <SessionTreeNode
              key={child.entry.id}
              node={child}
              depth={depth + 1}
              leafId={leafId}
              pendingEntryId={pendingEntryId}
              editingEntryId={editingEntryId}
              editingLabel={editingLabel}
              canNavigate={canNavigate}
              canFork={canFork}
              canClone={canClone}
              onNavigate={onNavigate}
              onFork={onFork}
              onClone={onClone}
              onStartLabel={onStartLabel}
              onEditingLabelChange={onEditingLabelChange}
              onSubmitLabel={onSubmitLabel}
              onCancelLabel={onCancelLabel}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
})

export const SessionTreePanel = memo(function SessionTreePanel({
  sessionId,
  onNavigateSession,
}: SessionTreePanelProps) {
  const { t } = useTranslation('components')
  const capabilities = usePiCapabilities()
  const snapshot = useSyncExternalStore(
    sessionProjectionStore.subscribe.bind(sessionProjectionStore),
    () => sessionProjectionStore.getSnapshot(sessionId),
    () => null,
  )
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null)
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [importCwd, setImportCwd] = useState('')
  const [compactInstructions, setCompactInstructions] = useState('')
  const [runtimePending, setRuntimePending] = useState<string | null>(null)
  const [summarizeNavigation, setSummarizeNavigation] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handleCommandUpdate = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<{
        sessionId?: string
        status?: string
        commandType?: string
        error?: { message?: string }
      }>).detail
      if (detail?.sessionId !== sessionId || detail.commandType !== 'session.compact') return
      if (detail.status === 'completed' || detail.status === 'failed' || detail.status === 'cancelled' ||
        detail.status === 'unknown_after_crash') {
        setRuntimePending(current => current === 'compact' ? null : current)
        if (detail.status !== 'completed' && detail.error?.message) setError(detail.error.message)
      }
    }
    window.addEventListener('piui:command-updated', handleCommandUpdate)
    return () => window.removeEventListener('piui:command-updated', handleCommandUpdate)
  }, [sessionId])

  useEffect(() => {
    if (runtimePending === 'compact' && snapshot?.runtime.compaction.operation.type !== 'none') {
      setRuntimePending(null)
    }
  }, [runtimePending, snapshot?.runtime.compaction.operation.type])

  const applyReplacement = useCallback(
    (
      result: SessionReplacementResponse<'session.fork' | 'session.clone' | 'session.import'>,
    ) => {
      applySnapshotToUi(result.sourceSnapshot, { activate: false })
      applySnapshotToUi(result.targetSnapshot)
      if (result.replacement.cancelled) return
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
      onNavigateSession?.({
        id: result.replacement.targetSessionId,
        directory: result.replacement.targetCwd,
      })
    },
    [onNavigateSession],
  )

  const runEntryCommand = useCallback(async (entryId: string, command: () => Promise<void>) => {
    setPendingEntryId(entryId)
    setError(null)
    try {
      await command()
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : t('sessionTree.failed'))
    } finally {
      setPendingEntryId(null)
    }
  }, [t])

  const handleNavigate = useCallback(
    (entryId: string) => {
      if (!capabilities.sessionNavigate) return
      void runEntryCommand(entryId, async () => {
        const result = summarizeNavigation
          ? await navigatePiSessionTree(sessionId, entryId, true)
          : await navigatePiSessionTree(sessionId, entryId)
        startTransition(() => {
          applySnapshotToUi(result.snapshot)
        })
        if (result.cancelled || result.aborted) return
        if (result.editorText === undefined) clearSessionEditorDraft(sessionId)
        else setSessionEditorDraft(sessionId, result.editorText)
      })
    },
    [capabilities.sessionNavigate, runEntryCommand, sessionId, summarizeNavigation],
  )

  const runRuntimeCommand = useCallback(async (
    operation: string,
    command: () => Promise<{ snapshot?: import('@piui/protocol').SessionSnapshotV1 }>,
    waitForCommandEvent = false,
  ) => {
    setRuntimePending(operation)
    setError(null)
    try {
      const result = await command()
      if (result.snapshot) applySnapshotToUi(result.snapshot, { activate: false })
    } catch (commandError) {
      if (waitForCommandEvent) setRuntimePending(null)
      setError(commandError instanceof Error ? commandError.message : t('sessionTree.failed'))
    } finally {
      if (!waitForCommandEvent) setRuntimePending(null)
    }
  }, [t])

  const handleToggleTool = useCallback((toolName: string, enabled: boolean) => {
    if (!snapshot || !capabilities.toolsManage) return
    const next = enabled
      ? [...new Set([...snapshot.runtime.activeTools, toolName])]
      : snapshot.runtime.activeTools.filter(name => name !== toolName)
    void runRuntimeCommand('tools', () => setPiActiveTools(sessionId, next))
  }, [capabilities.toolsManage, runRuntimeCommand, sessionId, snapshot])

  const handleFork = useCallback(
    (entryId: string) => {
      if (!capabilities.fork) return
      void runEntryCommand(entryId, async () => {
        applyReplacement(await forkPiSession(sessionId, entryId, 'at'))
      })
    },
    [applyReplacement, capabilities.fork, runEntryCommand, sessionId],
  )

  const handleClone = useCallback(
    (entryId: string) => {
      if (!capabilities.sessionClone) return
      void runEntryCommand(entryId, async () => {
        applyReplacement(await clonePiSession(sessionId, entryId))
      })
    },
    [applyReplacement, capabilities.sessionClone, runEntryCommand, sessionId],
  )

  const handleStartLabel = useCallback((entryId: string, label?: string) => {
    setEditingEntryId(entryId)
    setEditingLabel(label ?? '')
  }, [])

  const handleSubmitLabel = useCallback(
    (entryId: string) => {
      void runEntryCommand(entryId, async () => {
        const label = editingLabel.trim()
        const result = await setPiSessionLabel(sessionId, entryId, label || undefined)
        startTransition(() => {
          applySnapshotToUi(result.snapshot)
        })
        setEditingEntryId(null)
        setEditingLabel('')
      })
    },
    [editingLabel, runEntryCommand, sessionId],
  )

  const handleImport = useCallback(() => {
    const path = importPath.trim()
    if (!path || !capabilities.sessionImport) return
    void runEntryCommand('import', async () => {
      applyReplacement(await importPiSession(sessionId, path, importCwd.trim() || undefined))
      setImportOpen(false)
      setImportPath('')
      setImportCwd('')
    })
  }, [applyReplacement, capabilities.sessionImport, importCwd, importPath, runEntryCommand, sessionId])

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-100">
      {snapshot && (capabilities.compactionManage || capabilities.retryManage) ? (
        <div className="shrink-0 border-b border-border-200/40 px-3 py-2">
          {capabilities.compactionManage ? (
            <form
              className="flex items-center gap-1"
              onSubmit={event => {
                event.preventDefault()
                void runRuntimeCommand('compact', () => compactSession(
                  sessionId,
                  compactInstructions.trim() || undefined,
                ), true)
              }}
            >
              <input
                value={compactInstructions}
                onChange={event => setCompactInstructions(event.target.value)}
                placeholder={t('sessionTree.compactInstructions')}
                className="h-8 min-w-0 flex-1 rounded border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100"
              />
              {snapshot.runtime.compaction.operation.type === 'none' ? (
                <IconButton
                  type="submit"
                  aria-label={t('sessionTree.compact')}
                  title={t('sessionTree.compact')}
                  disabled={runtimePending !== null}
                >
                  <RetryIcon size={14} />
                </IconButton>
              ) : (
                <IconButton
                  aria-label={t('sessionTree.stopSummary')}
                  title={t('sessionTree.stopSummary')}
                  disabled={runtimePending !== null}
                  onClick={() => void runRuntimeCommand(
                    'abort-summary',
                    () => snapshot.runtime.compaction.operation.type === 'branchSummary'
                      ? abortPiBranchSummary(sessionId)
                      : abortPiCompaction(sessionId),
                  )}
                >
                  <StopIcon size={14} />
                </IconButton>
              )}
            </form>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--fs-xs)] text-text-300">
            {capabilities.compactionManage ? (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={snapshot.runtime.compaction.autoEnabled}
                  disabled={runtimePending !== null}
                  onChange={event => void runRuntimeCommand(
                    'auto-compaction',
                    () => setPiAutoCompaction(sessionId, event.target.checked),
                  )}
                />
                {t('sessionTree.autoCompaction')}
              </label>
            ) : null}
            {capabilities.retryManage ? (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={snapshot.runtime.retry.autoEnabled}
                  disabled={runtimePending !== null}
                  onChange={event => void runRuntimeCommand(
                    'auto-retry',
                    () => setPiAutoRetry(sessionId, event.target.checked),
                  )}
                />
                {t('sessionTree.autoRetry')}
              </label>
            ) : null}
            {snapshot.runtime.retry.phase === 'waiting' || snapshot.runtime.retry.phase === 'running' ? (
              <button
                type="button"
                className="text-danger-100 hover:underline"
                onClick={() => void runRuntimeCommand('abort-retry', () => abortPiRetry(sessionId))}
              >
                {t('sessionTree.stopRetry', {
                  attempt: snapshot.runtime.retry.attempt,
                  max: snapshot.runtime.retry.maxAttempts,
                })}
              </button>
            ) : null}
          </div>
          {snapshot.runtime.compaction.operation.type !== 'none' ? (
            <p className="mt-1 text-[length:var(--fs-xs)] text-text-400">
              {snapshot.runtime.compaction.operation.type === 'branchSummary'
                ? t('sessionTree.summarizingBranch')
                : t('sessionTree.compacting')}
            </p>
          ) : snapshot.runtime.compaction.lastNotice ? (
            <p className="mt-1 text-[length:var(--fs-xs)] text-text-400">
              {snapshot.runtime.compaction.lastNotice}
            </p>
          ) : snapshot.runtime.compaction.lastError ? (
            <p className="mt-1 text-[length:var(--fs-xs)] text-danger-100">
              {snapshot.runtime.compaction.lastError}
            </p>
          ) : snapshot.runtime.compaction.lastResult ? (
            <p
              className="mt-1 truncate text-[length:var(--fs-xs)] text-text-400"
              title={snapshot.runtime.compaction.lastResult.summary}
            >
              {t('sessionTree.compactionResult', {
                before: snapshot.runtime.compaction.lastResult.tokensBefore,
                after: snapshot.runtime.compaction.lastResult.estimatedTokensAfter ?? '?',
              })}
            </p>
          ) : null}
          {snapshot.runtime.retry.phase === 'waiting' ? (
            <p className="mt-1 text-[length:var(--fs-xs)] text-text-400">
              {t('sessionTree.retryWaiting', {
                attempt: snapshot.runtime.retry.attempt,
                max: snapshot.runtime.retry.maxAttempts,
                delay: snapshot.runtime.retry.delayMs,
                error: snapshot.runtime.retry.errorMessage,
              })}
            </p>
          ) : snapshot.runtime.retry.phase === 'running' ? (
            <p className="mt-1 text-[length:var(--fs-xs)] text-text-400">
              {t('sessionTree.retryRunning', {
                attempt: snapshot.runtime.retry.attempt,
                max: snapshot.runtime.retry.maxAttempts,
              })}
            </p>
          ) : snapshot.runtime.retry.phase === 'finished' && !snapshot.runtime.retry.success ? (
            <p className="mt-1 text-[length:var(--fs-xs)] text-danger-100">
              {snapshot.runtime.retry.finalError ?? t('sessionTree.retryFailed')}
            </p>
          ) : snapshot.runtime.retry.phase === 'finished' ? (
            <p className="mt-1 text-[length:var(--fs-xs)] text-text-400">
              {t('sessionTree.retrySucceeded', { attempt: snapshot.runtime.retry.attempt })}
            </p>
          ) : null}
        </div>
      ) : null}

      {snapshot && capabilities.queueManage ? (
        <div className="shrink-0 border-b border-border-200/40 px-3 py-2 text-[length:var(--fs-xs)]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-text-200">{t('sessionTree.queue')}</span>
            <IconButton
              size="sm"
              aria-label={t('sessionTree.clearQueue')}
              title={t('sessionTree.clearQueue')}
              disabled={runtimePending !== null ||
                snapshot.runtime.queue.steering.length + snapshot.runtime.queue.followUp.length === 0}
              onClick={() => void runRuntimeCommand('clear-queue', () => clearPiQueue(sessionId))}
            >
              <TrashIcon size={13} />
            </IconButton>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(['steering', 'followUp'] as const).map(kind => (
              <div key={kind} className="min-w-0">
                <label className="flex items-center justify-between gap-1 text-text-400">
                  <span>{t(`sessionTree.${kind}`)}</span>
                  <select
                    aria-label={t(`sessionTree.${kind}Mode`)}
                    value={kind === 'steering'
                      ? snapshot.runtime.queue.steeringMode
                      : snapshot.runtime.queue.followUpMode}
                    disabled={runtimePending !== null}
                    className="h-7 max-w-28 rounded border border-border-200 bg-bg-100 px-1 text-text-200"
                    onChange={event => void runRuntimeCommand('queue-mode', () => setPiQueueModes(sessionId, {
                      [kind === 'steering' ? 'steeringMode' : 'followUpMode']:
                        event.target.value as 'all' | 'one-at-a-time',
                    }))}
                  >
                    <option value="one-at-a-time">{t('sessionTree.oneAtATime')}</option>
                    <option value="all">{t('sessionTree.allAtOnce')}</option>
                  </select>
                </label>
                <div className="mt-1 space-y-1">
                  {snapshot.runtime.queue[kind].map((message, index) => (
                    <div key={`${kind}-${index}-${message}`} className="truncate text-text-300" title={message}>
                      {message}
                    </div>
                  ))}
                  {snapshot.runtime.queue[kind].length === 0 ? (
                    <span className="text-text-500">{t('sessionTree.queueEmpty')}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {snapshot && capabilities.toolsManage ? (
        <details className="shrink-0 border-b border-border-200/40 px-3 py-2">
          <summary className="cursor-pointer text-[length:var(--fs-sm)] font-medium text-text-200">
            {t('sessionTree.activeTools', { active: snapshot.runtime.activeTools.length, total: snapshot.runtime.tools.length })}
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
            {snapshot.runtime.tools.map(tool => (
              <label key={tool.name} className="flex min-w-0 items-start gap-1.5 text-[length:var(--fs-xs)] text-text-300">
                <input
                  type="checkbox"
                  checked={snapshot.runtime.activeTools.includes(tool.name)}
                  disabled={runtimePending !== null}
                  onChange={event => handleToggleTool(tool.name, event.target.checked)}
                />
                <span className="min-w-0 truncate" title={tool.description}>{tool.name}</span>
              </label>
            ))}
          </div>
        </details>
      ) : null}

      {snapshot && capabilities.sessionNavigate && capabilities.compactionManage ? (
        <label className="flex shrink-0 items-center gap-2 border-b border-border-200/40 px-3 py-2 text-[length:var(--fs-xs)] text-text-300">
          <input
            type="checkbox"
            checked={summarizeNavigation}
            onChange={event => setSummarizeNavigation(event.target.checked)}
          />
          {t('sessionTree.summarizeNavigation')}
        </label>
      ) : null}

      {capabilities.sessionImport ? (
        <div className="shrink-0 border-b border-border-200/40 px-2 py-2">
          {importOpen ? (
            <form
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-1"
              onSubmit={event => {
                event.preventDefault()
                handleImport()
              }}
            >
              <input
                autoFocus
                value={importPath}
                onChange={event => setImportPath(event.target.value)}
                placeholder={t('sessionTree.importPath')}
                className="h-8 min-w-0 flex-1 rounded border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100"
              />
              <IconButton aria-label={t('sessionTree.runImport')} title={t('sessionTree.runImport')} type="submit">
                <UploadIcon size={14} />
              </IconButton>
              <IconButton
                aria-label={t('sessionTree.cancel')}
                title={t('sessionTree.cancel')}
                onClick={() => setImportOpen(false)}
              >
                <CloseIcon size={14} />
              </IconButton>
              <input
                value={importCwd}
                onChange={event => setImportCwd(event.target.value)}
                placeholder={t('sessionTree.importCwd')}
                className="col-span-3 h-8 min-w-0 rounded border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100"
              />
            </form>
          ) : (
            <button
              type="button"
              className="flex h-8 items-center gap-2 rounded px-2 text-[length:var(--fs-sm)] text-text-300 hover:bg-bg-200/50 hover:text-text-100"
              onClick={() => setImportOpen(true)}
            >
              <UploadIcon size={14} />
              {t('sessionTree.import')}
            </button>
          )}
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="shrink-0 border-b border-danger-100/30 px-3 py-2 text-[length:var(--fs-xs)] text-danger-100">
          {error}
        </div>
      ) : null}

      <div role="tree" aria-label={t('panelContainer.sessionTree')} className="min-h-0 flex-1 overflow-auto">
        {snapshot?.native.tree.length ? (
          snapshot.native.tree.map(node => (
            <SessionTreeNode
              key={node.entry.id}
              node={node}
              depth={0}
              leafId={snapshot.native.leafId}
              pendingEntryId={pendingEntryId}
              editingEntryId={editingEntryId}
              editingLabel={editingLabel}
              canNavigate={capabilities.sessionNavigate}
              canFork={capabilities.fork}
              canClone={capabilities.sessionClone}
              onNavigate={handleNavigate}
              onFork={handleFork}
              onClone={handleClone}
              onStartLabel={handleStartLabel}
              onEditingLabelChange={setEditingLabel}
              onSubmitLabel={handleSubmitLabel}
              onCancelLabel={() => setEditingEntryId(null)}
            />
          ))
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-[length:var(--fs-sm)] text-text-400">
            {t('sessionTree.empty')}
          </div>
        )}
      </div>
    </div>
  )
})
