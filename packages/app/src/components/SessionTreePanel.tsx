import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
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
  fetchPiNativeTree,
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
import { nativeSessionStore } from '../pi/nativeSessionStore'
import { SessionTreeCanvas } from './SessionTreeCanvas'
import { SessionTreeDetail } from './SessionTreeDetail'
import { useVerticalSplitResize } from '../hooks/useVerticalSplitResize'
import {
  findSessionTreeNode,
  type NativeEntry,
  type NativeTreeNode,
} from './sessionTreeGraph'

interface SessionTreePanelProps {
  sessionId: string
  onNavigateSession?: (session: { id: string; directory?: string }) => void
}


export const SessionTreePanel = memo(function SessionTreePanel({
  sessionId,
  onNavigateSession,
}: SessionTreePanelProps) {
  const { t } = useTranslation('components')
  const capabilities = usePiCapabilities()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const snapshot = useSyncExternalStore(
    nativeSessionStore.subscribe.bind(nativeSessionStore),
    () => nativeSessionStore.getSnapshot(sessionId),
    () => null,
  )
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null)
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [importCwd, setImportCwd] = useState('')
  const [compactInstructions, setCompactInstructions] = useState('')
  const [runtimePending, setRuntimePending] = useState<string | null>(null)
  const [nativeTree, setNativeTree] = useState<NativeTreeNode[]>([])
  const [nativeLoading, setNativeLoading] = useState(false)
  const [nativeLoadError, setNativeLoadError] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const nativeRevisionRef = useRef<string | undefined>(undefined)
  const nativeRequestRef = useRef(0)
  const {
    splitHeight: canvasHeight,
    isResizing,
    handleResizeStart,
    handleTouchResizeStart,
    resetSplitHeight,
  } = useVerticalSplitResize({
    containerRef,
    primaryRef: canvasRef,
    cssVariableName: '--session-tree-canvas-height',
    minPrimaryHeight: 180,
    minSecondaryHeight: 160,
    defaultPrimaryHeightRatio: 0.55,
  })
  const loadNativeTree = useCallback(async () => {
    if (!sessionId) return
    const request = ++nativeRequestRef.current
    setNativeLoading(true)
    setNativeLoadError(null)
    try {
      const tree = await fetchPiNativeTree(sessionId)
      if (request !== nativeRequestRef.current) return
      setNativeTree(tree as NativeTreeNode[])
    } catch (cause) {
      if (request !== nativeRequestRef.current) return
      setNativeLoadError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === nativeRequestRef.current) setNativeLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    nativeRequestRef.current += 1
    nativeRevisionRef.current = snapshot ? `${snapshot.native.epoch}:${snapshot.native.revision}` : undefined
    setNativeTree([])
    setDetailOpen(false)
    resetSplitHeight()
    const timer = window.setTimeout(() => { void loadNativeTree() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadNativeTree])

  useEffect(() => {
    const revision = snapshot ? `${snapshot.native.epoch}:${snapshot.native.revision}` : undefined
    if (revision === undefined || revision === nativeRevisionRef.current) return
    nativeRevisionRef.current = revision
    void loadNativeTree()
  }, [loadNativeTree, snapshot?.native.epoch, snapshot?.native.revision])
  useEffect(() => {
    if (nativeTree.length === 0) {
      setSelectedEntryId(null)
      setDetailOpen(false)
      return
    }
    setSelectedEntryId(current => {
      if (findSessionTreeNode(nativeTree, current)) return current
      const leafId = snapshot?.native.leafId ?? null
      if (findSessionTreeNode(nativeTree, leafId)) return leafId
      return typeof nativeTree[0]?.entry.id === 'string' ? nativeTree[0].entry.id : null
    })
  }, [nativeTree, snapshot?.native.leafId])
  const [summarizeNavigation, setSummarizeNavigation] = useState(false)
  const [navigationInstructions, setNavigationInstructions] = useState('')
  const [replaceNavigationInstructions, setReplaceNavigationInstructions] = useState(false)
  const [navigationLabel, setNavigationLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const selectedNode = useMemo(
    () => findSessionTreeNode(nativeTree, selectedEntryId),
    [nativeTree, selectedEntryId],
  )
  const selectedEntry = selectedNode?.entry
  const selectedEntryType = typeof selectedEntry?.type === 'string' ? selectedEntry.type : 'unknown'
  const selectedMessage = selectedEntryType === 'message' && selectedEntry?.message &&
    typeof selectedEntry.message === 'object' && !Array.isArray(selectedEntry.message)
    ? selectedEntry.message as NativeEntry
    : undefined
  const selectedRole = typeof selectedMessage?.role === 'string' ? selectedMessage.role : undefined
  const selectedIsLeaf = selectedEntryId !== null && selectedEntryId === snapshot?.native.leafId

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
        const hasSummaryOptions = Boolean(navigationInstructions.trim() || navigationLabel.trim() || replaceNavigationInstructions)
        const result = summarizeNavigation
          ? hasSummaryOptions
            ? await navigatePiSessionTree(sessionId, entryId, true, {
                customInstructions: navigationInstructions.trim() || undefined,
                replaceInstructions: replaceNavigationInstructions,
                label: navigationLabel.trim() || undefined,
              })
            : await navigatePiSessionTree(sessionId, entryId, true)
          : await navigatePiSessionTree(sessionId, entryId)
        startTransition(() => {
          applySnapshotToUi(result.snapshot)
        })
        if (result.cancelled || result.aborted) return
        if (result.editorText === undefined) clearSessionEditorDraft(sessionId)
        else setSessionEditorDraft(sessionId, result.editorText)
      })
    },
    [capabilities.sessionNavigate, navigationInstructions, navigationLabel, replaceNavigationInstructions, runEntryCommand, sessionId, summarizeNavigation],
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
    <div ref={containerRef} className="flex h-full min-h-0 flex-col bg-bg-100">
      <details className="shrink-0 border-b border-border-200/40 bg-bg-100">
        <summary className="cursor-pointer px-3 py-2 text-[length:var(--fs-sm)] font-medium text-text-300 hover:bg-bg-200/40 hover:text-text-100">
          {t('sessionTree.sessionControls')}
        </summary>
        <div className="max-h-[45vh] overflow-y-auto border-t border-border-200/40">
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
        </div>
      </details>

      {error ? (
        <div role="alert" className="shrink-0 border-b border-danger-100/30 px-3 py-2 text-[length:var(--fs-xs)] text-danger-100">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 flex flex-col">
        <div
          ref={canvasRef}
          className="shrink-0 overflow-hidden"
          style={{
            '--session-tree-canvas-height': canvasHeight !== null ? `${canvasHeight}px` : '55%',
            height: detailOpen && selectedNode ? 'var(--session-tree-canvas-height)' : '100%',
            minHeight: detailOpen && selectedNode ? 180 : undefined,
          } as React.CSSProperties}
        >
          <SessionTreeCanvas
            sessionId={sessionId}
            tree={nativeTree}
            leafId={snapshot?.native.leafId ?? null}
            selectedEntryId={selectedEntryId}
            pendingEntryId={pendingEntryId}
            loading={nativeLoading}
            error={nativeLoadError}
            onSelectEntry={id => { setSelectedEntryId(id); setDetailOpen(true) }}
          />
        </div>

        {detailOpen && selectedNode && selectedEntryId ? (
          <>
            <div
              className={`h-1.5 cursor-row-resize shrink-0 relative transition-colors ${
                isResizing ? 'bg-accent-main-100' : 'bg-bg-200/60 hover:bg-accent-main-100/50'
              }`}
              onMouseDown={handleResizeStart}
              onTouchStart={handleTouchResizeStart}
            />
            <section className="flex min-h-0 flex-1 flex-col bg-bg-100" style={{ minHeight: 160 }} aria-label={t('sessionTree.selectedEntry')}>
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-200/40 px-3">
                <span className="truncate text-[length:var(--fs-sm)] font-medium text-text-100">
                  {selectedNode.label || t(selectedRole ? `sessionTree.roles.${selectedRole === 'toolResult' ? 'tool' : selectedRole}` : `sessionTree.entryTypes.${selectedEntryType}`)}
                </span>
                {selectedIsLeaf ? (
                  <span className="shrink-0 rounded bg-accent-main-100/12 px-1.5 py-0.5 text-[length:var(--fs-xs)] font-medium text-accent-main-100">
                    {t('sessionTree.current')}
                  </span>
                ) : null}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <IconButton aria-label={t('sessionTree.closeDetail')} title={t('sessionTree.closeDetail')} size="sm" onClick={() => { setDetailOpen(false); resetSplitHeight() }}>
                    <CloseIcon size={12} />
                  </IconButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
                <SessionTreeDetail
                  sessionId={sessionId}
                  directory={snapshot?.session.directory ?? '/'}
                  node={selectedNode}
                  selectedEntryId={selectedEntryId}
                />
                {selectedNode.label ? (
                  <p className="mt-1.5 text-[length:var(--fs-xs)] text-text-500">
                    {t('sessionTree.labelLine', { label: selectedNode.label, time: selectedNode.labelTimestamp ?? '' })}
                  </p>
                ) : null}

                {capabilities.sessionNavigate && !selectedIsLeaf ? (
                  <p className="mt-2 rounded border border-border-200/40 bg-bg-200/30 px-2.5 py-2 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
                    {selectedRole === 'user' || selectedEntryType === 'custom_message'
                      ? t('sessionTree.navigateUserHint')
                      : t('sessionTree.navigateEntryHint')}
                  </p>
                ) : null}
              </div>

              <div className="shrink-0 border-t border-border-200/40 px-3 py-2">
                {editingEntryId === selectedEntryId ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={editingLabel}
                      onChange={event => setEditingLabel(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') handleSubmitLabel(selectedEntryId)
                        if (event.key === 'Escape') setEditingEntryId(null)
                      }}
                      aria-label={t('sessionTree.labelPlaceholder')}
                      placeholder={t('sessionTree.labelPlaceholder')}
                      autoComplete="off"
                      className="h-8 min-w-0 flex-1 rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 focus-visible:border-accent-main-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-main-100"
                    />
                    <IconButton aria-label={t('common:save')} title={t('common:save')} size="sm" onClick={() => handleSubmitLabel(selectedEntryId)}>
                      <CheckIcon size={13} />
                    </IconButton>
                    <IconButton aria-label={t('sessionTree.cancel')} title={t('sessionTree.cancel')} size="sm" onClick={() => setEditingEntryId(null)}>
                      <CloseIcon size={13} />
                    </IconButton>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {capabilities.sessionNavigate && !selectedIsLeaf ? (
                      <button
                        type="button"
                        disabled={pendingEntryId !== null}
                        onClick={() => handleNavigate(selectedEntryId)}
                        className="h-7 rounded-md bg-accent-main-100 px-2.5 text-[length:var(--fs-xs)] font-medium text-bg-100 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-main-100/60 disabled:opacity-50"
                      >
                        {t('sessionTree.navigate')}
                      </button>
                    ) : null}
                    <IconButton aria-label={t('sessionTree.label')} title={t('sessionTree.label')} size="sm" disabled={pendingEntryId !== null} onClick={() => handleStartLabel(selectedEntryId, selectedNode.label)}>
                      <PencilIcon size={13} />
                    </IconButton>
                    {capabilities.fork ? (
                      <IconButton aria-label={t('sessionTree.fork')} title={t('sessionTree.fork')} size="sm" disabled={pendingEntryId !== null} onClick={() => handleFork(selectedEntryId)}>
                        <GitBranchIcon size={13} />
                      </IconButton>
                    ) : null}
                    {capabilities.sessionClone ? (
                      <IconButton aria-label={t('sessionTree.clone')} title={t('sessionTree.clone')} size="sm" disabled={pendingEntryId !== null} onClick={() => handleClone(selectedEntryId)}>
                        <CopyIcon size={13} />
                      </IconButton>
                    ) : null}
                    {capabilities.sessionNavigate && capabilities.compactionManage && !selectedIsLeaf ? (
                      <details className="text-[length:var(--fs-xs)] text-text-300">
                        <summary className="cursor-pointer select-none hover:text-text-100">{t('sessionTree.navigationOptions')}</summary>
                        <div className="mt-2 space-y-2 border-l border-border-200 pl-2">
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={summarizeNavigation} onChange={event => setSummarizeNavigation(event.target.checked)} />
                            {t('sessionTree.summarizeNavigation')}
                          </label>
                          {summarizeNavigation ? (
                            <>
                              <input
                                className="h-7 w-full rounded-md border border-border-200 bg-bg-100 px-2 text-text-100 focus-visible:border-accent-main-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-main-100"
                                value={navigationInstructions}
                                aria-label={t('sessionTree.branchSummaryInstructions')}
                                placeholder={t('sessionTree.branchSummaryInstructions')}
                                autoComplete="off"
                                onChange={event => setNavigationInstructions(event.target.value)}
                              />
                              <input
                                className="h-7 w-full rounded-md border border-border-200 bg-bg-100 px-2 text-text-100 focus-visible:border-accent-main-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-main-100"
                                value={navigationLabel}
                                aria-label={t('sessionTree.optionalBranchLabel')}
                                placeholder={t('sessionTree.optionalBranchLabel')}
                                autoComplete="off"
                                onChange={event => setNavigationLabel(event.target.value)}
                              />
                              <label className="flex items-center gap-2">
                                <input type="checkbox" checked={replaceNavigationInstructions} onChange={event => setReplaceNavigationInstructions(event.target.checked)} />
                                {t('sessionTree.replaceDefaultInstructions')}
                              </label>
                            </>
                          ) : null}
                        </div>
                      </details>
                    ) : null}
                  </div>
                )}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  )
})
