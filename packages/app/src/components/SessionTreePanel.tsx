import { memo, startTransition, useCallback, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { PiSessionEntryV1, PiSessionTreeNodeV1 } from '@piui/protocol'
import { CheckIcon, CloseIcon, CopyIcon, GitBranchIcon, PencilIcon, UploadIcon } from './Icons'
import { IconButton } from './ui/IconButton'
import { applySnapshotToUi } from '../pi/applySnapshot'
import { usePiCapabilities } from '../pi/capabilities'
import {
  clonePiSession,
  forkPiSession,
  importPiSession,
  navigatePiSessionTree,
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
  const [error, setError] = useState<string | null>(null)

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
        const result = await navigatePiSessionTree(sessionId, entryId)
        startTransition(() => {
          applySnapshotToUi(result.snapshot)
        })
        if (result.cancelled || result.aborted) return
        if (result.editorText === undefined) clearSessionEditorDraft(sessionId)
        else setSessionEditorDraft(sessionId, result.editorText)
      })
    },
    [capabilities.sessionNavigate, runEntryCommand, sessionId],
  )

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
