import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckIcon,
  CloseIcon,
  StopIcon,
  TrashIcon,
  UploadIcon,
} from './Icons'
import { IconButton } from './ui/IconButton'
import { SegmentedControl, SettingField, SettingRow, SettingsSection, Toggle } from '../features/settings/components/SettingsUI'
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
import { useVerticalSplitResize } from '../hooks/useVerticalSplitResize'
import { nativeEntriesToUiMessages, type PiNativeEntry } from '../pi/nativeEntriesToMessages'
import { MessageRenderer } from '../features/message/MessageRenderer'
import {
  buildSessionTreeGraph,
  findSessionTreeNode,
  sessionTreeEntryPreview,
  type NativeEntry,
  type NativeTreeNode,
} from './sessionTreeGraph'

interface SessionTreePanelProps {
  sessionId: string
  mode?: 'tree' | 'controls'
  onNavigateSession?: (session: { id: string; directory?: string }) => void
}


export const SessionTreePanel = memo(function SessionTreePanel({
  sessionId,
  mode = 'tree',
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
    adjustSplitHeight,
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
    if (!sessionId || mode !== 'tree') return
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
  }, [mode, sessionId])

  useEffect(() => {
    if (mode !== 'tree') return
    nativeRequestRef.current += 1
    nativeRevisionRef.current = snapshot ? `${snapshot.native.epoch}:${snapshot.native.revision}` : undefined
    setNativeTree([])
    setDetailOpen(false)
    resetSplitHeight()
    const timer = window.setTimeout(() => { void loadNativeTree() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadNativeTree, mode])

  useEffect(() => {
    if (mode !== 'tree') return
    const revision = snapshot ? `${snapshot.native.epoch}:${snapshot.native.revision}` : undefined
    if (revision === undefined || revision === nativeRevisionRef.current) return
    nativeRevisionRef.current = revision
    void loadNativeTree()
  }, [loadNativeTree, mode, snapshot?.native.epoch, snapshot?.native.revision])
  const treeGraph = useMemo(
    () => buildSessionTreeGraph(nativeTree, snapshot?.native.leafId ?? null, type => t(`sessionTree.entryTypes.${type}`)),
    [nativeTree, snapshot?.native.leafId, t],
  )
  useEffect(() => {
    if (nativeTree.length === 0) {
      setSelectedEntryId(null)
      setDetailOpen(false)
      return
    }
    setSelectedEntryId(current => {
      if (current && treeGraph.nodeById.has(current)) return current
      return treeGraph.nodes.find(node => node.data.currentLeaf)?.id ?? treeGraph.nodes[0]?.id ?? null
    })
  }, [nativeTree.length, treeGraph])
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
  const selectedPreview = selectedEntry
    ? sessionTreeEntryPreview(selectedEntry, type => t(`sessionTree.entryTypes.${type}`))
    : ''
  const selectedMessage = selectedEntryType === 'message' && selectedEntry?.message &&
    typeof selectedEntry.message === 'object' && !Array.isArray(selectedEntry.message)
    ? selectedEntry.message as NativeEntry
    : undefined
  const selectedRole = typeof selectedMessage?.role === 'string' ? selectedMessage.role : undefined
  const selectedIsLeaf = treeGraph.nodes.some(node => node.id === selectedEntryId && node.data.currentLeaf)
  const selectedDetailEntries = selectedEntryId ? treeGraph.detailEntriesById.get(selectedEntryId) ?? [] : []
  const snapshotDirectory = snapshot?.session.directory
  const snapshotModelProvider = snapshot?.runtime.model?.provider
  const snapshotModelId = snapshot?.runtime.model?.id
  const selectedDetailMessages = useMemo(() => {
    if (!selectedEntryId || !snapshotDirectory) return []
    return nativeEntriesToUiMessages(selectedDetailEntries as PiNativeEntry[], {
      sessionId,
      directory: snapshotDirectory,
      model: snapshotModelProvider && snapshotModelId
        ? { providerID: snapshotModelProvider, modelID: snapshotModelId }
        : undefined,
    })
  }, [selectedDetailEntries, selectedEntryId, sessionId, snapshotDirectory, snapshotModelId, snapshotModelProvider])
  const splitMaxHeight = Math.max(0, (containerRef.current?.clientHeight ?? 500) - 160)
  const splitMinHeight = Math.min(180, splitMaxHeight)

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
      setImportPath('')
      setImportCwd('')
    })
  }, [applyReplacement, capabilities.sessionImport, importCwd, importPath, runEntryCommand, sessionId])

  const queuedCount = snapshot
    ? snapshot.runtime.queue.steering.length + snapshot.runtime.queue.followUp.length
    : 0
  const activeToolCount = snapshot?.runtime.activeTools.length ?? 0
  const totalToolCount = snapshot?.runtime.tools.length ?? 0
  const runtimeBusy = snapshot
    ? snapshot.runtime.compaction.operation.type !== 'none' ||
      snapshot.runtime.retry.phase === 'waiting' ||
      snapshot.runtime.retry.phase === 'running'
    : false

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-100">
      {mode === 'controls' ? (
        <section className="flex h-full min-h-0 flex-col bg-bg-100" aria-label={t('sessionTree.sessionControls')}>
          {runtimeBusy ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border-200/40 px-4 py-2 text-[length:var(--fs-xs)] text-text-400">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warning-100" />
              {snapshot!.runtime.compaction.operation.type !== 'none'
                ? snapshot!.runtime.compaction.operation.type === 'branchSummary'
                  ? t('sessionTree.summarizingBranch')
                  : t('sessionTree.compacting')
                : snapshot!.runtime.retry.phase === 'waiting' || snapshot!.runtime.retry.phase === 'running'
                  ? t('sessionTree.retryRunning', {
                      attempt: snapshot!.runtime.retry.attempt,
                      max: snapshot!.runtime.retry.maxAttempts,
                    })
                  : null}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {snapshot && (capabilities.compactionManage || capabilities.retryManage) ? (
        <SettingsSection title={t('sessionTree.runtimeControls')} description={t('sessionTree.runtimeControlsHint')}>
          {capabilities.compactionManage ? (
            <SettingRow
              label={t('sessionTree.autoCompaction')}
              description={t('sessionTree.autoCompactionHint')}
            >
              <Toggle
                enabled={snapshot.runtime.compaction.autoEnabled}
                disabled={runtimePending !== null}
                onChange={() => void runRuntimeCommand(
                  'auto-compaction',
                  () => setPiAutoCompaction(sessionId, !snapshot.runtime.compaction.autoEnabled),
                )}
              />
            </SettingRow>
          ) : null}
          {capabilities.retryManage ? (
            <SettingRow
              label={t('sessionTree.autoRetry')}
              description={t('sessionTree.autoRetryHint')}
            >
              <Toggle
                enabled={snapshot.runtime.retry.autoEnabled}
                disabled={runtimePending !== null}
                onChange={() => void runRuntimeCommand(
                  'auto-retry',
                  () => setPiAutoRetry(sessionId, !snapshot.runtime.retry.autoEnabled),
                )}
              />
            </SettingRow>
          ) : null}
          {capabilities.compactionManage ? (
            <SettingField
              label={t('sessionTree.compact')}
              description={t('sessionTree.compactHint')}
            >
              <form
                className="flex items-center gap-2"
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
                  aria-label={t('sessionTree.compactInstructions')}
                  placeholder={t('sessionTree.compactInstructions')}
                  autoComplete="off"
                  className="h-8 min-w-0 flex-1 rounded-md border border-border-200 bg-transparent px-2.5 text-[length:var(--fs-sm)] text-text-100 placeholder:text-text-400 outline-none transition-colors hover:border-border-300 focus-visible:border-accent-main-100"
                />
                {snapshot.runtime.compaction.operation.type === 'none' ? (
                  <button
                    type="submit"
                    disabled={runtimePending !== null}
                    className="h-8 shrink-0 rounded-md bg-bg-200 px-3 text-[length:var(--fs-sm)] font-medium text-text-200 transition-colors hover:bg-bg-300 hover:text-text-100 disabled:opacity-40"
                  >
                    {t('sessionTree.compactNow')}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={runtimePending !== null}
                    onClick={() => void runRuntimeCommand(
                      'abort-summary',
                      () => snapshot.runtime.compaction.operation.type === 'branchSummary'
                        ? abortPiBranchSummary(sessionId)
                        : abortPiCompaction(sessionId),
                    )}
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-danger-100/30 bg-danger-100/10 px-3 text-[length:var(--fs-sm)] font-medium text-danger-100 transition-colors hover:bg-danger-100/15 disabled:opacity-40"
                  >
                    <StopIcon size={12} />
                    {t('sessionTree.stopSummary')}
                  </button>
                )}
              </form>
            </SettingField>
          ) : null}
          {snapshot.runtime.retry.phase === 'waiting' || snapshot.runtime.retry.phase === 'running' ? (
            <SettingRow
              label={t('sessionTree.stopRetry', {
                attempt: snapshot.runtime.retry.attempt,
                max: snapshot.runtime.retry.maxAttempts,
              })}
              description={snapshot.runtime.retry.phase === 'waiting'
                ? t('sessionTree.retryWaiting', {
                    attempt: snapshot.runtime.retry.attempt,
                    max: snapshot.runtime.retry.maxAttempts,
                    delay: snapshot.runtime.retry.delayMs,
                    error: snapshot.runtime.retry.errorMessage,
                  })
                : undefined}
            >
              <button
                type="button"
                className="flex h-7 items-center gap-1.5 rounded-md border border-danger-100/30 bg-danger-100/10 px-2.5 text-[length:var(--fs-sm)] text-danger-100 transition-colors hover:bg-danger-100/15"
                onClick={() => void runRuntimeCommand('abort-retry', () => abortPiRetry(sessionId))}
              >
                <StopIcon size={12} />
                {t('sessionTree.stop')}
              </button>
            </SettingRow>
          ) : null}
          {snapshot.runtime.compaction.operation.type === 'none' &&
          (snapshot.runtime.compaction.lastNotice ||
            snapshot.runtime.compaction.lastError ||
            snapshot.runtime.compaction.lastResult ||
            snapshot.runtime.retry.phase === 'finished') ? (
            <div className="text-[length:var(--fs-xs)] leading-relaxed">
              {snapshot.runtime.compaction.lastNotice ? (
                <p className="text-text-400">{snapshot.runtime.compaction.lastNotice}</p>
              ) : snapshot.runtime.compaction.lastError ? (
                <p className="text-danger-100">{snapshot.runtime.compaction.lastError}</p>
              ) : snapshot.runtime.compaction.lastResult ? (
                <p className="truncate text-text-400" title={snapshot.runtime.compaction.lastResult.summary}>
                  {t('sessionTree.compactionResult', {
                    before: snapshot.runtime.compaction.lastResult.tokensBefore,
                    after: snapshot.runtime.compaction.lastResult.estimatedTokensAfter ?? '?',
                  })}
                </p>
              ) : null}
              {snapshot.runtime.retry.phase === 'finished' ? (
                <p className={snapshot.runtime.retry.success ? 'text-text-400' : 'text-danger-100'}>
                  {snapshot.runtime.retry.success
                    ? t('sessionTree.retrySucceeded', { attempt: snapshot.runtime.retry.attempt })
                    : snapshot.runtime.retry.finalError ?? t('sessionTree.retryFailed')}
                </p>
              ) : null}
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      {snapshot && capabilities.queueManage ? (
        <SettingsSection
          title={t('sessionTree.queue')}
          description={t('sessionTree.queueHint')}
          actions={(
            <button
              type="button"
              disabled={runtimePending !== null || queuedCount === 0}
              onClick={() => void runRuntimeCommand('clear-queue', () => clearPiQueue(sessionId))}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-sm)] text-text-400 transition-colors hover:bg-bg-200/60 hover:text-text-100 disabled:opacity-40"
            >
              <TrashIcon size={13} />
              {t('sessionTree.clearQueue')}
              {queuedCount > 0 ? ` (${queuedCount})` : ''}
            </button>
          )}
        >
          <SettingField label={t('sessionTree.steering')} description={t('sessionTree.steeringHint')}>
            <div className="w-56 max-w-full">
              <SegmentedControl
                value={snapshot.runtime.queue.steeringMode}
                options={[
                  { value: 'one-at-a-time' as const, label: t('sessionTree.oneAtATime') },
                  { value: 'all' as const, label: t('sessionTree.allAtOnce') },
                ]}
                onChange={value => {
                  if (runtimePending !== null) return false
                  void runRuntimeCommand('queue-mode', () => setPiQueueModes(sessionId, { steeringMode: value }))
                }}
              />
            </div>
          </SettingField>
          <SettingField label={t('sessionTree.followUp')} description={t('sessionTree.followUpHint')}>
            <div className="w-56 max-w-full">
              <SegmentedControl
                value={snapshot.runtime.queue.followUpMode}
                options={[
                  { value: 'one-at-a-time' as const, label: t('sessionTree.oneAtATime') },
                  { value: 'all' as const, label: t('sessionTree.allAtOnce') },
                ]}
                onChange={value => {
                  if (runtimePending !== null) return false
                  void runRuntimeCommand('queue-mode', () => setPiQueueModes(sessionId, { followUpMode: value }))
                }}
              />
            </div>
          </SettingField>
        </SettingsSection>
      ) : null}

      {snapshot && capabilities.toolsManage ? (
        <SettingsSection
          title={t('sessionTree.tools')}
          description={t('sessionTree.toolsHint')}
          actions={(
            <span className="text-[length:var(--fs-xs)] text-text-400">
              {t('sessionTree.activeTools', { active: activeToolCount, total: totalToolCount })}
            </span>
          )}
        >
          {snapshot.runtime.tools.map(tool => (
            <SettingRow
              key={tool.name}
              label={tool.name}
              description={tool.description || undefined}
              disabled={runtimePending !== null}
            >
              <Toggle
                enabled={snapshot.runtime.activeTools.includes(tool.name)}
                disabled={runtimePending !== null}
                onChange={() => handleToggleTool(
                  tool.name,
                  !snapshot.runtime.activeTools.includes(tool.name),
                )}
              />
            </SettingRow>
          ))}
        </SettingsSection>
      ) : null}

      {capabilities.sessionImport ? (
        <SettingsSection title={t('sessionTree.importTitle')} description={t('sessionTree.importHint')}>
          <form
            className="flex flex-col gap-2.5"
            onSubmit={event => {
              event.preventDefault()
              handleImport()
            }}
          >
            <input
              value={importPath}
              onChange={event => setImportPath(event.target.value)}
              aria-label={t('sessionTree.importPath')}
              placeholder={t('sessionTree.importPath')}
              autoComplete="off"
              className="h-8 min-w-0 rounded-md border border-border-200 bg-transparent px-2.5 text-[length:var(--fs-sm)] text-text-100 placeholder:text-text-400 outline-none transition-colors hover:border-border-300 focus-visible:border-accent-main-100"
            />
            <input
              value={importCwd}
              onChange={event => setImportCwd(event.target.value)}
              aria-label={t('sessionTree.importCwd')}
              placeholder={t('sessionTree.importCwd')}
              autoComplete="off"
              className="h-8 min-w-0 rounded-md border border-border-200 bg-transparent px-2.5 text-[length:var(--fs-sm)] text-text-100 placeholder:text-text-400 outline-none transition-colors hover:border-border-300 focus-visible:border-accent-main-100"
            />
            <div>
              <button
                type="submit"
                disabled={!importPath.trim() || pendingEntryId !== null}
                className="flex h-8 items-center gap-2 rounded-md bg-bg-200 px-3 text-[length:var(--fs-sm)] font-medium text-text-200 transition-colors hover:bg-bg-300 hover:text-text-100 disabled:opacity-40"
              >
                <UploadIcon size={14} />
                {t('sessionTree.runImport')}
              </button>
            </div>
          </form>
        </SettingsSection>
      ) : null}
          </div>
        </section>
      ) : null}

      {error ? (
        <div role="alert" className="shrink-0 border-b border-danger-100/30 px-3 py-2 text-[length:var(--fs-xs)] text-danger-100">
          {error}
        </div>
      ) : null}

      <div ref={containerRef} className={mode === 'tree' ? 'min-h-0 flex-1 flex flex-col' : 'hidden'}>
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
            graph={treeGraph}
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
              role="separator"
              tabIndex={0}
              aria-orientation="horizontal"
              aria-label={t('sessionTree.resizeDetail')}
              aria-valuemin={splitMinHeight}
              aria-valuemax={splitMaxHeight}
              aria-valuenow={Math.round(canvasHeight ?? splitMinHeight)}
              className={`h-2 cursor-row-resize shrink-0 relative transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-main-100 ${
                isResizing ? 'bg-accent-main-100' : 'bg-bg-200/60 hover:bg-accent-main-100/50'
              }`}
              onMouseDown={handleResizeStart}
              onTouchStart={handleTouchResizeStart}
              onKeyDown={event => {
                if (event.key === 'ArrowUp') { event.preventDefault(); adjustSplitHeight(-24) }
                if (event.key === 'ArrowDown') { event.preventDefault(); adjustSplitHeight(24) }
              }}
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
                {selectedDetailMessages.length > 0 ? (
                  <div className="space-y-3">
                    {selectedDetailMessages.map(message => (
                      <MessageRenderer key={message.info.id} message={message} isTurnLatestAssistant />
                    ))}
                  </div>
                ) : (
                  <p className="break-words whitespace-pre-wrap text-[length:var(--fs-xs)] leading-relaxed text-text-300">
                    {selectedPreview}
                  </p>
                )}
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
                    <button
                      type="button"
                      disabled={pendingEntryId !== null}
                      onClick={() => handleStartLabel(selectedEntryId, selectedNode.label)}
                      className="h-7 rounded-md border border-border-200 bg-bg-100 px-2.5 text-[length:var(--fs-xs)] text-text-200 hover:bg-bg-200/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-main-100 disabled:opacity-50"
                    >
                      {t('sessionTree.label')}
                    </button>
                    {capabilities.fork ? (
                      <button
                        type="button"
                        disabled={pendingEntryId !== null}
                        onClick={() => handleFork(selectedEntryId)}
                        className="h-7 rounded-md border border-border-200 bg-bg-100 px-2.5 text-[length:var(--fs-xs)] text-text-200 hover:bg-bg-200/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-main-100 disabled:opacity-50"
                      >
                        {t('sessionTree.fork')}
                      </button>
                    ) : null}
                    {capabilities.sessionClone ? (
                      <button
                        type="button"
                        disabled={pendingEntryId !== null}
                        onClick={() => handleClone(selectedEntryId)}
                        className="h-7 rounded-md border border-border-200 bg-bg-100 px-2.5 text-[length:var(--fs-xs)] text-text-200 hover:bg-bg-200/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-main-100 disabled:opacity-50"
                      >
                        {t('sessionTree.clone')}
                      </button>
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
