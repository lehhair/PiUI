import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { JsonObject, JsonValue, ToolDescriptor } from '@piui/protocol'
import type { SessionEntry } from '../pi/domain'
import {
  CheckIcon,
  CloseIcon,
  GitBranchIcon,
  PencilIcon,
  ReturnIcon,
  StopIcon,
  TrashIcon,
  UploadIcon,
} from './Icons'
import { IconButton } from './ui/IconButton'
import { SegmentedControl, SettingField, SettingRow, SettingsDisclosure, SettingsSection, Toggle } from '../features/settings/components/SettingsUI'
import { usePiCapabilities } from '../pi/capabilities'
import { stashForkText } from '../pi/pendingForkText'
import {
  abortPiBranchSummary,
  abortPiCompaction,
  abortPiRetry,
  clearPiQueue,
  compactPiSession,
  forkPiSession,
  importPiSession,
  loadPiSessionTools,
  navigatePiTree,
  refreshPiSessionState,
  setPiActiveTools,
  setPiAutoCompaction,
  setPiAutoRetry,
  setPiEntryLabel,
  setPiFollowUpMode,
  setPiSteeringMode,
} from '../pi/controllers/index.js'
import { getPiTree, type PiForkResult } from '../pi/transport/index.js'
import { commitRedoPlan } from '../pi/redoPlanStore'
import { clearSessionEditorDraft, setSessionEditorDraft } from '../pi/sessionEditorDraftStore'
import { usePiSessionRuntimeState } from '../pi/hooks/index.js'
import { selectPiTimelineItems } from '../pi/selectors/index.js'
import type { PiBranchPage } from '../pi/domain'
import { SessionTreeCanvas } from './SessionTreeCanvas'
import { useVerticalSplitResize } from '../hooks/useVerticalSplitResize'
import { MessageRenderer } from '../features/message/MessageRenderer'
import {
  buildSessionTreeGraph,
  findSessionTreeNode,
  findNewestDescendantEntries,
  isTreeVisibleEntry,
  sessionTreeEntryPreview,
  type NativeEntry,
  type NativeTreeNode,
} from './sessionTreeGraph'

interface SessionTreePanelProps {
  sessionId: string
  mode?: 'tree' | 'controls'
  onNavigateSession?: (session: { id: string; directory?: string }) => void
  onNewChat?: () => void
}

// Typed views over the runtime state JsonObject (state.get). Shapes are
// defined by the worker's shadows — not SDK types — so local views it is.
interface CompactionView {
  autoEnabled?: boolean
  operation?: { type?: string }
  lastNotice?: string | null
  lastError?: string | null
  lastResult?: { summary?: string; tokensBefore?: number; estimatedTokensAfter?: number | null } | null
}

interface RetryView {
  phase?: string
  attempt?: number
  maxAttempts?: number
  autoEnabled?: boolean
  delayMs?: number
  errorMessage?: string | null
  success?: boolean
  finalError?: string | null
}

interface QueueView {
  steering?: string[]
  followUp?: string[]
  steeringMode?: 'all' | 'one-at-a-time'
  followUpMode?: 'all' | 'one-at-a-time'
}

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** redo 可落节点：树上可见、非 user 消息（落在 user 消息 = 撤销语义） */
function isRedoLandingEntry(entry: NativeEntry, currentLeafId: string | null): boolean {
  if (typeof entry.id !== 'string' || !entry.id) return false
  if (!isTreeVisibleEntry(entry, currentLeafId)) return false
  const type = typeof entry.type === 'string' ? entry.type : ''
  const role = record(entry.message as JsonValue).role
  return !(type === 'message' && role === 'user')
}

export const SessionTreePanel = memo(function SessionTreePanel({
  sessionId,
  mode = 'tree',
  onNavigateSession,
  onNewChat,
}: SessionTreePanelProps) {
  const { t } = useTranslation('components')
  const capabilities = usePiCapabilities()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const state = usePiSessionRuntimeState(sessionId)
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
  const [tools, setTools] = useState<ToolDescriptor[]>([])
  const headFingerprintRef = useRef<string | undefined>(undefined)
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

  // Runtime state views
  const compaction = useMemo(() => record(state?.compaction) as CompactionView, [state])
  const retry = useMemo(() => record(state?.retry) as RetryView, [state])
  const queue = useMemo(() => record(state?.queue) as QueueView, [state])
  const activeTools = useMemo(
    () => (Array.isArray(state?.activeTools) ? state.activeTools.filter((name): name is string => typeof name === 'string') : []),
    [state],
  )
  const head = useMemo(() => record(state?.head), [state])
  const headRevision = typeof head.revision === 'number' ? head.revision : undefined
  const leafId = typeof head.leafId === 'string' ? head.leafId : null
  const headFingerprint = headRevision !== undefined ? `${headRevision}:${leafId ?? ''}` : undefined
  const compactionOperation = compaction.operation?.type ?? 'none'
  const retryPhase = retry.phase ?? 'idle'

  const loadNativeTree = useCallback(async () => {
    if (!sessionId || mode !== 'tree') return
    const request = ++nativeRequestRef.current
    setNativeLoading(true)
    setNativeLoadError(null)
    try {
      const tree = await getPiTree(sessionId)
      if (request !== nativeRequestRef.current) return
      setNativeTree(tree as unknown as NativeTreeNode[])
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
    headFingerprintRef.current = headFingerprint
    setNativeTree([])
    setDetailOpen(false)
    resetSplitHeight()
    const timer = window.setTimeout(() => { void loadNativeTree() }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadNativeTree, mode])

  // Reload the tree whenever the native head moves (navigate/label/new entries)
  useEffect(() => {
    if (mode !== 'tree') return
    if (headFingerprint === undefined || headFingerprint === headFingerprintRef.current) return
    headFingerprintRef.current = headFingerprint
    void loadNativeTree()
  }, [headFingerprint, loadNativeTree, mode])

  // 压缩是异步的：命令返回时条目还没写入，等 operation 从忙转闲再补一次重载
  const compactionBusyRef = useRef(false)
  useEffect(() => {
    const busy = compactionOperation !== 'none'
    if (compactionBusyRef.current && !busy && mode === 'tree') void loadNativeTree()
    compactionBusyRef.current = busy
  }, [compactionOperation, loadNativeTree, mode])

  // Tools list for the controls tab (registry.get, immediate)
  useEffect(() => {
    if (mode !== 'controls') return
    let cancelled = false
    void loadPiSessionTools(sessionId)
      .then(descriptors => { if (!cancelled) setTools(descriptors) })
      .catch(() => { if (!cancelled) setTools([]) })
    return () => { cancelled = true }
  }, [mode, sessionId, state])

  const treeGraph = useMemo(
    () => buildSessionTreeGraph(nativeTree, leafId, type => t(`sessionTree.entryTypes.${type}`)),
    [nativeTree, leafId, t],
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
  const selectedDetailItems = useMemo(
    () =>
      selectPiTimelineItems({
        items: (selectedEntryId ? treeGraph.detailEntriesById.get(selectedEntryId) ?? [] : []) as unknown as SessionEntry[],
      } as unknown as PiBranchPage),
    [selectedEntryId, treeGraph],
  )
  const splitMaxHeight = Math.max(0, (containerRef.current?.clientHeight ?? 500) - 160)
  const splitMinHeight = Math.min(180, splitMaxHeight)

  const applyReplacement = useCallback(
    (result: PiForkResult) => {
      if (result.cancelled || !result.targetSessionId) return
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
      onNavigateSession?.({
        id: result.targetSessionId,
        directory: result.targetCwd ?? undefined,
      })
    },
    [onNavigateSession],
  )

  const runEntryCommand = useCallback(async (entryId: string, command: () => Promise<void>) => {
    setPendingEntryId(entryId)
    setError(null)
    try {
      await command()
      // 树操作（navigate/fork/label）完成后主动刷新运行时状态并重载树，
      // 不能干等 head 指纹变化——这些操作不一定会推状态事件
      void refreshPiSessionState(sessionId).catch(() => undefined)
      void loadNativeTree()
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : t('sessionTree.failed'))
    } finally {
      setPendingEntryId(null)
    }
  }, [loadNativeTree, sessionId, t])

  const handleNavigate = useCallback(
    (entryId: string) => {
      if (!capabilities.sessionNavigate) return
      // redo = 目标向下的后续可落节点（沿最新子分支，树上可见且非 user 消息——
      // pi 的 navigateTree 落在 user 消息上是撤销语义，不能作为 redo 落点）。
      // 条数即剩余节点数；目标是叶子时为空，不出 redo
      const targetNode = findSessionTreeNode(nativeTree, entryId)
      const checkpoints = targetNode
        ? findNewestDescendantEntries(targetNode)
            .filter(entry => isRedoLandingEntry(entry, leafId))
            .map(entry => String(entry.id))
        : []
      void runEntryCommand(entryId, async () => {
        const result = await navigatePiTree(sessionId, {
          entryId,
          summarize: summarizeNavigation || undefined,
          customInstructions: navigationInstructions.trim() || undefined,
          replaceInstructions: replaceNavigationInstructions || undefined,
          label: navigationLabel.trim() || undefined,
        })
        if (result.cancelled || result.aborted) return
        if (result.editorText == null) clearSessionEditorDraft(sessionId)
        else setSessionEditorDraft(sessionId, result.editorText)
        await commitRedoPlan(sessionId, checkpoints)
      })
    },
    [capabilities.sessionNavigate, nativeTree, leafId, navigationInstructions, navigationLabel, replaceNavigationInstructions, runEntryCommand, sessionId, summarizeNavigation],
  )

  const runRuntimeCommand = useCallback(async (
    operation: string,
    command: () => Promise<void>,
    refreshState = true,
  ) => {
    setRuntimePending(operation)
    setError(null)
    try {
      await command()
      if (refreshState) void refreshPiSessionState(sessionId).catch(() => undefined)
      // 压缩等运行时操作也会往树里写入新条目
      void loadNativeTree()
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : t('sessionTree.failed'))
    } finally {
      setRuntimePending(null)
    }
  }, [loadNativeTree, sessionId, t])

  const handleToggleTool = useCallback((toolName: string, enabled: boolean) => {
    if (!capabilities.toolsManage) return
    const next = enabled
      ? [...new Set([...activeTools, toolName])]
      : activeTools.filter(name => name !== toolName)
    void runRuntimeCommand('tools', () => setPiActiveTools(sessionId, next))
  }, [activeTools, capabilities.toolsManage, runRuntimeCommand, sessionId])

  const handleFork = useCallback(
    (entryId: string) => {
      if (!capabilities.fork) return
      // fork 第一条用户消息 = 没有历史可分，纯前端开新会话预填，不留孤儿
      const firstUserNode = treeGraph.nodes.find(node => node.data.type === 'message' && node.data.role === 'user')
      if (firstUserNode && firstUserNode.id === entryId && entryId === selectedEntryId && selectedMessage) {
        const content = (selectedMessage as { content?: unknown }).content
        const text = Array.isArray(content)
          ? content
              .filter((block): block is { type: 'text'; text: string } =>
                Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string'),
              )
              .map(block => block.text)
              .join('\n')
          : ''
        stashForkText('home', text)
        onNewChat?.()
        return
      }
      void runEntryCommand(entryId, async () => {
        // pi TUI parity：fork 从该用户消息之前分叉，消息文本带回输入框改写重发
        const result = await forkPiSession(sessionId, entryId, 'before')
        if (!result.cancelled && result.targetSessionId && typeof result.selectedText === 'string' && result.selectedText.trim()) {
          stashForkText(result.targetSessionId, result.selectedText)
        }
        applyReplacement(result)
      })
    },
    [applyReplacement, capabilities.fork, runEntryCommand, sessionId, treeGraph, selectedEntryId, selectedMessage, onNewChat],
  )

  const handleStartLabel = useCallback((entryId: string, label?: string) => {
    setEditingEntryId(entryId)
    setEditingLabel(label ?? '')
  }, [])

  const handleSubmitLabel = useCallback(
    (entryId: string) => {
      void runEntryCommand(entryId, async () => {
        const label = editingLabel.trim()
        await setPiEntryLabel(sessionId, entryId, label || undefined)
        void refreshPiSessionState(sessionId).catch(() => undefined)
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

  const queuedCount = (queue.steering?.length ?? 0) + (queue.followUp?.length ?? 0)
  const activeToolCount = activeTools.length
  const totalToolCount = tools.length
  const runtimeBusy = compactionOperation !== 'none' || retryPhase === 'waiting' || retryPhase === 'running'

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-100">
      {mode === 'controls' ? (
        <section className="flex h-full min-h-0 flex-col bg-bg-100" aria-label={t('sessionTree.sessionControls')}>
          {runtimeBusy ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border-200/40 px-4 py-2 text-[length:var(--fs-xs)] text-text-400">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warning-100" />
              {compactionOperation !== 'none'
                ? compactionOperation === 'branchSummary'
                  ? t('sessionTree.summarizingBranch')
                  : t('sessionTree.compacting')
                : retryPhase === 'waiting' || retryPhase === 'running'
                  ? t('sessionTree.retryRunning', {
                      attempt: retry.attempt,
                      max: retry.maxAttempts,
                    })
                  : null}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {state && (capabilities.compactionManage || capabilities.retryManage) ? (
        <SettingsSection title={t('sessionTree.runtimeControls')} description={t('sessionTree.runtimeControlsHint')}>
          {capabilities.compactionManage ? (
            <SettingRow
              label={t('sessionTree.autoCompaction')}
              description={t('sessionTree.autoCompactionHint')}
            >
              <Toggle
                enabled={compaction.autoEnabled === true}
                disabled={runtimePending !== null}
                onChange={() => void runRuntimeCommand(
                  'auto-compaction',
                  () => setPiAutoCompaction(sessionId, compaction.autoEnabled !== true),
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
                enabled={retry.autoEnabled === true}
                disabled={runtimePending !== null}
                onChange={() => void runRuntimeCommand(
                  'auto-retry',
                  () => setPiAutoRetry(sessionId, retry.autoEnabled !== true),
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
                  void runRuntimeCommand('compact', () => compactPiSession(
                    sessionId,
                    compactInstructions.trim() || undefined,
                  ).then(() => undefined))
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
                {compactionOperation === 'none' ? (
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
                      () => compactionOperation === 'branchSummary'
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
          {retryPhase === 'waiting' || retryPhase === 'running' ? (
            <SettingRow
              label={t('sessionTree.stopRetry', {
                attempt: retry.attempt,
                max: retry.maxAttempts,
              })}
              description={retryPhase === 'waiting'
                ? t('sessionTree.retryWaiting', {
                    attempt: retry.attempt,
                    max: retry.maxAttempts,
                    delay: retry.delayMs,
                    error: retry.errorMessage,
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
          {compactionOperation === 'none' &&
          (compaction.lastNotice ||
            compaction.lastError ||
            compaction.lastResult ||
            retryPhase === 'finished') ? (
            <div className="text-[length:var(--fs-xs)] leading-relaxed">
              {compaction.lastNotice ? (
                <p className="text-text-400">{compaction.lastNotice}</p>
              ) : compaction.lastError ? (
                <p className="text-danger-100">{compaction.lastError}</p>
              ) : compaction.lastResult ? (
                <p className="truncate text-text-400" title={compaction.lastResult.summary}>
                  {t('sessionTree.compactionResult', {
                    before: compaction.lastResult.tokensBefore,
                    after: compaction.lastResult.estimatedTokensAfter ?? '?',
                  })}
                </p>
              ) : null}
              {retryPhase === 'finished' ? (
                <p className={retry.success ? 'text-text-400' : 'text-danger-100'}>
                  {retry.success
                    ? t('sessionTree.retrySucceeded', { attempt: retry.attempt })
                    : retry.finalError ?? t('sessionTree.retryFailed')}
                </p>
              ) : null}
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      {state && capabilities.queueManage ? (
        <SettingsSection
          title={t('sessionTree.queue')}
          description={t('sessionTree.queueHint')}
          actions={(
            <button
              type="button"
              disabled={runtimePending !== null || queuedCount === 0}
              onClick={() => void runRuntimeCommand('clear-queue', () => clearPiQueue(sessionId).then(() => undefined))}
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
                value={queue.steeringMode ?? 'all'}
                options={[
                  { value: 'one-at-a-time' as const, label: t('sessionTree.oneAtATime') },
                  { value: 'all' as const, label: t('sessionTree.allAtOnce') },
                ]}
                onChange={value => {
                  if (runtimePending !== null) return false
                  void runRuntimeCommand('queue-mode', () => setPiSteeringMode(sessionId, value))
                }}
              />
            </div>
          </SettingField>
          <SettingField label={t('sessionTree.followUp')} description={t('sessionTree.followUpHint')}>
            <div className="w-56 max-w-full">
              <SegmentedControl
                value={queue.followUpMode ?? 'all'}
                options={[
                  { value: 'one-at-a-time' as const, label: t('sessionTree.oneAtATime') },
                  { value: 'all' as const, label: t('sessionTree.allAtOnce') },
                ]}
                onChange={value => {
                  if (runtimePending !== null) return false
                  void runRuntimeCommand('queue-mode', () => setPiFollowUpMode(sessionId, value))
                }}
              />
            </div>
          </SettingField>
        </SettingsSection>
      ) : null}

      {state && capabilities.toolsManage ? (
        <SettingsSection
          title={t('sessionTree.tools')}
          description={t('sessionTree.toolsHint')}
          actions={(
            <span className="text-[length:var(--fs-xs)] text-text-400">
              {t('sessionTree.activeTools', { active: activeToolCount, total: totalToolCount })}
            </span>
          )}
        >
          {tools.map(tool => (
            <SettingRow
              key={tool.name}
              label={tool.name}
              description={tool.description || undefined}
              disabled={runtimePending !== null}
            >
              <Toggle
                enabled={activeTools.includes(tool.name)}
                disabled={runtimePending !== null}
                onChange={() => handleToggleTool(
                  tool.name,
                  !activeTools.includes(tool.name),
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
              className={`group/sep relative flex h-2.5 shrink-0 cursor-row-resize items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-main-100 ${
                isResizing ? 'bg-accent-main-100/20' : 'hover:bg-bg-200/60'
              }`}
              onMouseDown={handleResizeStart}
              onTouchStart={handleTouchResizeStart}
              onKeyDown={event => {
                if (event.key === 'ArrowUp') { event.preventDefault(); adjustSplitHeight(-24) }
                if (event.key === 'ArrowDown') { event.preventDefault(); adjustSplitHeight(24) }
              }}
            >
              <span className={`h-1 w-8 rounded-full transition-colors ${isResizing ? 'bg-accent-main-100' : 'bg-border-200 group-hover/sep:bg-border-300'}`} aria-hidden="true" />
            </div>
            <section className="flex min-h-0 flex-1 flex-col bg-bg-100" style={{ minHeight: 160 }} aria-label={t('sessionTree.selectedEntry')}>
              <div className="flex min-h-9 shrink-0 items-center gap-2 px-4">
                <span className="min-w-0 truncate text-[length:var(--fs-sm)] font-medium text-text-100">
                  {selectedNode.label || t(selectedRole ? `sessionTree.roles.${selectedRole === 'toolResult' ? 'tool' : selectedRole}` : `sessionTree.entryTypes.${selectedEntryType}`)}
                </span>
                {selectedIsLeaf ? (
                  <span className="shrink-0 rounded bg-accent-main-100/12 px-1.5 py-0.5 text-[length:var(--fs-xs)] font-medium text-accent-main-100">
                    {t('sessionTree.current')}
                  </span>
                ) : null}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {editingEntryId !== selectedEntryId ? (
                    <>
                      <div className="flex items-center gap-0.5">
                        {capabilities.sessionNavigate && !selectedIsLeaf ? (
                          <IconButton
                            size="sm"
                            variant="solid"
                            disabled={pendingEntryId !== null}
                            aria-label={t('sessionTree.navigate')}
                            title={t('sessionTree.navigate')}
                            onClick={() => handleNavigate(selectedEntryId)}
                          >
                            <ReturnIcon size={13} />
                          </IconButton>
                        ) : null}
                        <IconButton
                          size="sm"
                          disabled={pendingEntryId !== null}
                          aria-label={t('sessionTree.label')}
                          title={t('sessionTree.label')}
                          onClick={() => handleStartLabel(selectedEntryId, selectedNode.label)}
                        >
                          <PencilIcon size={13} />
                        </IconButton>
                        {capabilities.fork && selectedRole === 'user' ? (
                          <IconButton
                            size="sm"
                            disabled={pendingEntryId !== null}
                            aria-label={t('sessionTree.fork')}
                            title={t('sessionTree.fork')}
                            onClick={() => handleFork(selectedEntryId)}
                          >
                            <GitBranchIcon size={13} />
                          </IconButton>
                        ) : null}
                      </div>
                      <span className="mx-0.5 h-4 w-px bg-border-200/50" aria-hidden="true" />
                    </>
                  ) : null}
                  <IconButton aria-label={t('sessionTree.closeDetail')} title={t('sessionTree.closeDetail')} size="sm" onClick={() => { setDetailOpen(false); resetSplitHeight() }}>
                    <CloseIcon size={12} />
                  </IconButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
                {selectedDetailItems.length > 0 ? (
                  <div className="space-y-3">
                    {selectedDetailItems.map(item => (
                      <MessageRenderer key={item.entryId} item={item} isTurnLatestAssistant />
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
                  <p className="mt-2 rounded-md bg-bg-200/40 px-3 py-2 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
                    {selectedRole === 'user' || selectedEntryType === 'custom_message'
                      ? t('sessionTree.navigateUserHint')
                      : t('sessionTree.navigateEntryHint')}
                  </p>
                ) : null}
              </div>

              <div className="shrink-0 px-4 pb-3 pt-1">
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
                    {capabilities.sessionNavigate && capabilities.compactionManage && !selectedIsLeaf ? (
                      <SettingsDisclosure title={t('sessionTree.navigationOptions')} className="w-full">
                        <div className="space-y-2 text-[length:var(--fs-xs)] text-text-300">
                          <label className="flex items-center gap-2">
                            <input type="checkbox" className="size-3.5 accent-accent-main-100" checked={summarizeNavigation} onChange={event => setSummarizeNavigation(event.target.checked)} />
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
                                <input type="checkbox" className="size-3.5 accent-accent-main-100" checked={replaceNavigationInstructions} onChange={event => setReplaceNavigationInstructions(event.target.checked)} />
                                {t('sessionTree.replaceDefaultInstructions')}
                              </label>
                            </>
                          ) : null}
                        </div>
                      </SettingsDisclosure>
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
