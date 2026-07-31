// ============================================
// FileExplorer - 文件浏览器组件
// 包含文件树和文件预览两个区域，支持拖拽调整高度
// 性能优化：使用 CSS 变量 + requestAnimationFrame 处理 resize
// ============================================

import { memo, useCallback, useMemo, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useFileExplorer, type FileTreeNode } from '../hooks'
import { useVerticalSplitResize } from '../hooks/useVerticalSplitResize'
import { layoutStore, type PreviewFile } from '../store/layoutStore'
import {
  ChevronRightIcon,
  ChevronDownIcon,
  RetryIcon,
  AlertCircleIcon,
  DownloadIcon,
  MaximizeIcon,
  SearchIcon,
  CloseIcon,
  CheckIcon,
  PencilIcon,
  PlusIcon,
  FileIcon,
  FolderIcon,
  TrashIcon,
} from './Icons'
import { CodePreview } from './CodePreview'
import { HtmlFilePreviewFrame } from './HtmlFilePreviewFrame'
import { PreviewTabsBar, type PreviewTabsBarItem } from './PreviewTabsBar'
import { MarkdownRenderer } from './MarkdownRenderer'
import { useFullscreenLayer } from '../contexts'
import { getMaterialIconUrl } from '../utils/materialIcons'
import { detectLanguage } from '../utils/languageUtils'
import {
  getPreviewCategory,
  isBinaryContent,
  isTextualMedia,
  buildDataUrl,
  buildTextDataUrl,
  decodeBase64Text,
  formatMimeType,
  type PreviewCategory,
} from '../utils/mimeUtils'
import { downloadFileContent } from '../utils/downloadUtils'
import { createDirectory, createFile, deleteEntry, moveEntry, searchText, searchFiles } from '../pi/files'
import type { FileReadResponse, WorkspaceTextSearchMatch } from '@piui/protocol'
import { startInternalDrag } from '../lib/internalDragCore'
import { toAbsolutePath } from '../features/mention'
import { getDesktopPlatform, isTauri, isTauriMobile } from '../utils/tauri'
import type { TargetLineRange } from './codeMirrorReadonlyExtensions'
import { setFileEditorDirty } from '../store/unsavedFileStore'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'

function canRevealInSystemExplorer(): boolean {
  return isTauri() && !isTauriMobile()
}

function getRevealInSystemExplorerLabel(t: (key: string) => string): string {
  switch (getDesktopPlatform()) {
    case 'windows':
      return t('fileExplorer.revealInExplorer')
    case 'macos':
      return t('fileExplorer.revealInFinder')
    default:
      return t('fileExplorer.revealInFileManager')
  }
}

async function revealPathInSystemExplorer(absolutePath: string) {
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
  await revealItemInDir(absolutePath)
}

// 常量
const MIN_TREE_HEIGHT = 100
const MIN_PREVIEW_HEIGHT = 150

const MARKDOWN_MIME_TYPES = new Set(['text/markdown', 'text/x-markdown', 'text/md', 'application/markdown'])
const HTML_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml'])

type FileOperation =
  | { kind: 'create-file'; parent: string }
  | { kind: 'create-directory'; parent: string }
  | { kind: 'rename'; path: string; type: 'file' | 'directory' }
  | { kind: 'delete'; path: string; type: 'file' | 'directory' }

function joinFilePath(parent: string, name: string): string {
  return parent ? `${parent.replace(/\/$/, '')}/${name}` : name
}
const textEncoder = new TextEncoder()

function isMarkdownPreview(language: string, mimeType?: string): boolean {
  if (language === 'markdown' || language === 'mdx') return true
  if (!mimeType) return false
  return MARKDOWN_MIME_TYPES.has(mimeType.split(';', 1)[0].toLowerCase())
}

function isHtmlPreview(language: string, mimeType?: string): boolean {
  if (language === 'html') return true
  if (!mimeType) return false
  return HTML_MIME_TYPES.has(mimeType.split(';', 1)[0].toLowerCase())
}

function byteOffsetToCodeUnitIndex(text: string, byteOffset: number): number {
  let bytes = 0
  let index = 0

  while (index < text.length && bytes < byteOffset) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break

    const char = String.fromCodePoint(codePoint)
    const charBytes = textEncoder.encode(char).length
    if (bytes + charBytes > byteOffset) break

    bytes += charBytes
    index += char.length
  }

  return Math.min(index, text.length)
}

function getSearchMatchRanges(match: WorkspaceTextSearchMatch): TargetLineRange[] {
  return match.submatches
    .map(submatch => ({
      from: byteOffsetToCodeUnitIndex(match.lines.text, submatch.start),
      to: byteOffsetToCodeUnitIndex(match.lines.text, submatch.end),
    }))
    .filter(range => range.to > range.from)
}

interface FileExplorerProps {
  panelTabId: string
  directory?: string
  previewFile: PreviewFile | null
  previewFiles: PreviewFile[]
  position?: 'bottom' | 'right'
  isPanelResizing?: boolean
  sessionId?: string | null
}

export const FileExplorer = memo(function FileExplorer({
  panelTabId,
  directory,
  previewFile,
  previewFiles,
  position = 'right',
  isPanelResizing = false,
  sessionId,
}: FileExplorerProps) {
  const { t } = useTranslation(['components', 'common'])
  const containerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const fileContextMenuRef = useRef<HTMLDivElement>(null)
  const searchRequestIdRef = useRef(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<WorkspaceTextSearchMatch[]>([])
  const [fileResults, setFileResults] = useState<string[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [fileContextMenu, setFileContextMenu] = useState<{
    x: number
    y: number
    path: string
    absolutePath?: string
    type: 'file' | 'directory'
  } | null>(null)
  const [fileOperation, setFileOperation] = useState<FileOperation | null>(null)
  const [fileOperationValue, setFileOperationValue] = useState('')
  const [fileOperationError, setFileOperationError] = useState<string | null>(null)
  const [fileOperationBusy, setFileOperationBusy] = useState(false)
  const canRevealFiles = canRevealInSystemExplorer()
  const revealInSystemExplorerLabel = useMemo(() => getRevealInSystemExplorerLabel(t), [t])
  const [searchError, setSearchError] = useState<string | null>(null)
  const {
    splitHeight: treeHeight,
    isResizing,
    resetSplitHeight,
    handleResizeStart,
    handleTouchResizeStart,
  } = useVerticalSplitResize({
    containerRef,
    primaryRef: treeRef,
    cssVariableName: '--tree-height',
    minPrimaryHeight: MIN_TREE_HEIGHT,
    minSecondaryHeight: MIN_PREVIEW_HEIGHT,
  })

  // 综合 resize 状态 - 外部面板 resize 或内部 resize
  const isAnyResizing = isPanelResizing || isResizing

  const {
    tree,
    isLoading,
    error,
    expandedPaths,
    toggleExpand,
    previewContent,
    previewLoading,
    previewError,
    loadPreview,
    clearPreview,
    savePreview,
    fileStatus,
    refresh,
  } = useFileExplorer({ directory, autoLoad: true, sessionId: sessionId || undefined, consumerId: `file-explorer-${panelTabId}` })

  // 当 previewFile 改变时加载预览
  useEffect(() => {
    if (previewFile) {
      loadPreview(previewFile.path)
    } else {
      clearPreview()
    }
  }, [previewFile, loadPreview, clearPreview])

  const handleRefresh = useCallback(async () => {
    await refresh()
    if (previewFile) {
      await loadPreview(previewFile.path)
    }
  }, [loadPreview, previewFile, refresh])

  // 处理文件点击
  const handleFileClick = useCallback(
    (node: FileTreeNode) => {
      if (node.type === 'directory') {
        toggleExpand(node.path)
      } else {
        layoutStore.openFilePreview({ path: node.path, name: node.name }, position)
      }
    },
    [toggleExpand, position],
  )

  const resolveAbsolutePath = useCallback(
    (path: string, absolute?: string) => {
      if (absolute) return absolute
      if (!directory) return null
      return toAbsolutePath(path, directory)
    },
    [directory],
  )

  const handleFileContextMenu = useCallback(
    (event: React.MouseEvent, path: string, absolute?: string, type: 'file' | 'directory' = 'file') => {
      const absolutePath = resolveAbsolutePath(path, absolute)
      event.preventDefault()
      event.stopPropagation()
      setFileContextMenu({ x: event.clientX, y: event.clientY, path, absolutePath: absolutePath ?? undefined, type })
    },
    [resolveAbsolutePath],
  )

  const handleRevealInSystemExplorer = useCallback(() => {
    if (!fileContextMenu) return
    const absolutePath = fileContextMenu.absolutePath
    if (!absolutePath) return
    setFileContextMenu(null)
    void revealPathInSystemExplorer(absolutePath).catch(() => {})
  }, [fileContextMenu])

  const openFileOperation = useCallback((operation: FileOperation) => {
    setFileContextMenu(null)
    setFileOperation(operation)
    setFileOperationError(null)
    setFileOperationValue(operation.kind === 'rename' ? operation.path.split('/').pop() ?? operation.path : '')
  }, [])

  const submitFileOperation = useCallback(async () => {
    if (!directory || !fileOperation || fileOperationBusy) return
    const value = fileOperationValue.trim()
    if (fileOperation.kind !== 'delete' && (!value || value.includes('/') || value.includes('\\'))) {
      setFileOperationError('Enter a single valid file or directory name')
      return
    }
    setFileOperationBusy(true)
    setFileOperationError(null)
    try {
      if (fileOperation.kind === 'create-file') {
        await createFile(joinFilePath(fileOperation.parent, value), directory)
      } else if (fileOperation.kind === 'create-directory') {
        await createDirectory(joinFilePath(fileOperation.parent, value), directory)
      } else if (fileOperation.kind === 'rename') {
        const separator = fileOperation.path.lastIndexOf('/')
        const parent = separator < 0 ? '' : fileOperation.path.slice(0, separator)
        const target = joinFilePath(parent, value)
        await moveEntry(fileOperation.path, target, directory)
        if (previewFile?.path === fileOperation.path) {
          layoutStore.closeFilePreview(panelTabId, fileOperation.path)
          layoutStore.openFilePreview({ path: target, name: value }, position)
        }
      } else {
        await deleteEntry(fileOperation.path, directory, fileOperation.type === 'directory')
        layoutStore.closeFilePreview(panelTabId, fileOperation.path)
      }
      setFileOperation(null)
      await refresh()
    } catch (operationError) {
      setFileOperationError(operationError instanceof Error ? operationError.message : 'File operation failed')
    } finally {
      setFileOperationBusy(false)
    }
  }, [directory, fileOperation, fileOperationBusy, fileOperationValue, panelTabId, position, previewFile?.path, refresh])

  useEffect(() => {
    if (!fileContextMenu) return

    const handleClickOutside = (event: MouseEvent) => {
      if (fileContextMenuRef.current && !fileContextMenuRef.current.contains(event.target as Node)) {
        setFileContextMenu(null)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFileContextMenu(null)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [fileContextMenu])

  // 关闭预览
  const handleClosePreview = useCallback(() => {
    layoutStore.closeAllFilePreviews(panelTabId)
    resetSplitHeight()
  }, [panelTabId, resetSplitHeight])

  const handleActivatePreview = useCallback(
    (path: string) => {
      layoutStore.activateFilePreview(panelTabId, path)
    },
    [panelTabId],
  )

  const handleClosePreviewTab = useCallback(
    (path: string) => {
      layoutStore.closeFilePreview(panelTabId, path)
    },
    [panelTabId],
  )

  const handleReorderPreviewTabs = useCallback(
    (draggedPath: string, targetPath: string) => {
      layoutStore.reorderFilePreviews(panelTabId, draggedPath, targetPath)
    },
    [panelTabId],
  )

  // 是否显示预览
  const showPreview = Boolean(previewFile) || previewLoading || Boolean(previewError)
  const trimmedSearchQuery = searchQuery.trim()
  const isSearchingText = trimmedSearchQuery.length > 0

  useEffect(() => {
    if (!directory || !trimmedSearchQuery) {
      searchRequestIdRef.current += 1
      return
    }

    const requestId = ++searchRequestIdRef.current
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setSearchLoading(true)
      setSearchResults([])
      setFileResults([])
      setSearchError(null)

      let fileDone = false
      let textDone = false
      const maybeFinish = () => {
        if (fileDone && textDone && requestId === searchRequestIdRef.current) {
          setSearchLoading(false)
        }
      }

      // 文件名搜索（失败静默，不阻断内容搜索）
      searchFiles(trimmedSearchQuery, { directory, limit: 50, signal: controller.signal })
        .then(paths => {
          if (requestId !== searchRequestIdRef.current) return
          setFileResults(paths)
        })
        .catch(err => {
          if (err instanceof DOMException && err.name === 'AbortError') return
          // 文件名搜索失败不报错
        })
        .finally(() => {
          fileDone = true
          maybeFinish()
        })

      // 内容搜索
      searchText(trimmedSearchQuery, directory, controller.signal)
        .then(results => {
          if (requestId !== searchRequestIdRef.current) return
          setSearchResults(results)
        })
        .catch(err => {
          if (err instanceof DOMException && err.name === 'AbortError') return
          if (requestId !== searchRequestIdRef.current) return
          setSearchResults([])
          setSearchError(err instanceof Error ? err.message : t('fileExplorer.textSearchFailed'))
        })
        .finally(() => {
          textDone = true
          maybeFinish()
        })
    }, 250)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [directory, trimmedSearchQuery, t])

  const handleSearchResultClick = useCallback(
    (match: WorkspaceTextSearchMatch) => {
      const path = match.path.text
      const name = path.split(/[/\\]/).pop() || path
      layoutStore.openFilePreview(
        {
          path,
          name,
          targetLine: match.line_number,
          targetKey: `${path}:${match.line_number}:${match.absolute_offset}:${Date.now()}`,
          targetRanges: getSearchMatchRanges(match),
        },
        position,
      )
    },
    [position],
  )

  const handleFileResultClick = useCallback(
    (path: string) => {
      const name = path.split(/[/\\]/).pop() || path
      layoutStore.openFilePreview({ path, name }, position)
    },
    [position],
  )

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value)
    if (!value.trim()) {
      setSearchResults([])
      setFileResults([])
      setSearchLoading(false)
      setSearchError(null)
    }
  }, [])

  // 没有选择目录
  if (!directory) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-400 text-[length:var(--fs-base)] gap-2 p-4">
        <img
          src={getMaterialIconUrl('folder', 'directory', false)}
          alt=""
          width={32}
          height={32}
          className="opacity-30"
          onError={e => {
            e.currentTarget.style.visibility = 'hidden'
          }}
        />
        <span className="text-center">{t('fileExplorer.selectProject')}</span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      {/* File Tree - 使用 CSS 变量控制高度 */}
      <div
        ref={treeRef}
        className="overflow-hidden flex flex-col shrink-0"
        style={
          {
            '--tree-height': treeHeight !== null ? `${treeHeight}px` : '40%',
            height: showPreview ? 'var(--tree-height)' : '100%',
            minHeight: showPreview ? MIN_TREE_HEIGHT : undefined,
          } as React.CSSProperties
        }
      >
        {/* Tree Header */}
        <div className="relative flex h-10 items-center gap-2 px-3 shrink-0">
          <div className="relative group min-w-0 flex-1">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-400 w-3.5 h-3.5 group-focus-within:text-accent-main-100 transition-colors" />
            <input
              type="text"
              name="file-explorer-text-search"
              value={searchQuery}
              onChange={e => handleSearchQueryChange(e.target.value)}
              placeholder={t('fileExplorer.searchFiles')}
              aria-label={t('fileExplorer.searchFiles')}
              autoComplete="off"
              className="w-full bg-bg-200/40 hover:bg-bg-200/60 focus:bg-bg-000 border border-transparent focus:border-border-200 rounded-lg py-1 pl-[30px] pr-7 text-[length:var(--fs-xs)] text-text-100 placeholder:text-text-400/70 focus-visible:ring-1 focus-visible:ring-border-200 focus-visible:ring-inset transition-all"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => handleSearchQueryChange('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center text-text-400 hover:text-text-100 rounded transition-colors"
                aria-label={t('fileExplorer.clearSearch')}
                title={t('fileExplorer.clearSearch')}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => openFileOperation({ kind: 'create-file', parent: '' })}
            aria-label="New file"
            className="inline-flex h-6 w-6 items-center justify-center text-text-400 hover:text-text-100 hover:bg-bg-200/50 rounded-md transition-colors"
            title="New file"
          >
            <FileIcon size={12} />
          </button>
          <button
            type="button"
            onClick={() => openFileOperation({ kind: 'create-directory', parent: '' })}
            aria-label="New directory"
            className="relative inline-flex h-6 w-6 items-center justify-center text-text-400 hover:text-text-100 hover:bg-bg-200/50 rounded-md transition-colors"
            title="New directory"
          >
            <FolderIcon size={12} />
            <PlusIcon size={7} className="absolute right-0.5 bottom-0.5" />
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isLoading}
            aria-label={t('common:refresh')}
            className="inline-flex h-6 w-6 items-center justify-center text-text-400 hover:text-text-100 hover:bg-bg-200/50 rounded-md transition-colors disabled:opacity-50"
            title={t('common:refresh')}
          >
            <RetryIcon size={12} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <div className="pointer-events-none absolute inset-x-3 bottom-0 h-px bg-border-200/30" />
        </div>

        {/* Tree Content */}
        <div className="flex-1 overflow-auto panel-scrollbar-y">
          {isSearchingText ? (
            <TextSearchResults
              results={searchResults}
              fileResults={fileResults}
              isLoading={searchLoading}
              error={searchError}
              onSelect={handleSearchResultClick}
              onSelectFile={handleFileResultClick}
              onContextMenuFile={handleFileContextMenu}
              directory={directory}
            />
          ) : isLoading && tree.length === 0 ? (
            <div className="flex items-center justify-center h-20 text-text-400 text-[length:var(--fs-sm)]">
              {t('common:loading')}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-20 text-danger-100 text-[length:var(--fs-sm)] gap-1 px-4">
              <AlertCircleIcon size={16} />
              <span className="text-center">{error}</span>
            </div>
          ) : tree.length === 0 ? (
            <div className="flex items-center justify-center h-20 text-text-400 text-[length:var(--fs-sm)]">
              {t('fileExplorer.noFilesFound')}
            </div>
          ) : (
            <div className="py-1">
              {tree.map(node => (
                <FileTreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  expandedPaths={expandedPaths}
                  fileStatus={fileStatus}
                  onClick={handleFileClick}
                  onContextMenu={handleFileContextMenu}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {fileContextMenu &&
        createPortal(
          <div
            ref={fileContextMenuRef}
            className="fixed z-[9999] bg-bg-100 border border-border-200 rounded-lg shadow-lg p-1 min-w-[160px]"
            style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
          >
            {canRevealFiles ? (
              <button type="button" onClick={handleRevealInSystemExplorer} className="w-full px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] text-text-200 hover:bg-bg-200/60 hover:text-text-100 rounded-md transition-colors">
                {revealInSystemExplorerLabel}
              </button>
            ) : null}
            {fileContextMenu.type === 'directory' ? (
              <>
                <button type="button" onClick={() => openFileOperation({ kind: 'create-file', parent: fileContextMenu.path })} className="w-full px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] text-text-200 hover:bg-bg-200/60 rounded-md">New file</button>
                <button type="button" onClick={() => openFileOperation({ kind: 'create-directory', parent: fileContextMenu.path })} className="w-full px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] text-text-200 hover:bg-bg-200/60 rounded-md">New directory</button>
              </>
            ) : null}
            <button type="button" onClick={() => openFileOperation({ kind: 'rename', path: fileContextMenu.path, type: fileContextMenu.type })} className="w-full px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] text-text-200 hover:bg-bg-200/60 rounded-md">Rename</button>
            <button type="button" onClick={() => openFileOperation({ kind: 'delete', path: fileContextMenu.path, type: fileContextMenu.type })} className="w-full px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] text-danger-100 hover:bg-danger-100/10 rounded-md flex items-center gap-2">
              <TrashIcon size={12} />Delete
            </button>
          </div>,
          document.body,
        )}

      <Dialog
        isOpen={fileOperation !== null}
        onClose={() => { if (!fileOperationBusy) setFileOperation(null) }}
        title={fileOperation?.kind === 'delete' ? 'Delete entry' : fileOperation?.kind === 'rename' ? 'Rename entry' : fileOperation?.kind === 'create-directory' ? 'New directory' : 'New file'}
        width={420}
      >
        <div className="space-y-3">
          {fileOperation?.kind === 'delete' ? (
            <p className="text-[length:var(--fs-sm)] text-text-200 break-all">Delete {fileOperation.path}{fileOperation.type === 'directory' ? ' and all of its contents' : ''}?</p>
          ) : (
            <input
              autoFocus
              value={fileOperationValue}
              onChange={event => setFileOperationValue(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void submitFileOperation() }}
              className="w-full h-8 rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100"
              aria-label="File name"
            />
          )}
          {fileOperationError ? <p className="text-[length:var(--fs-xs)] text-danger-100">{fileOperationError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setFileOperation(null)} disabled={fileOperationBusy}>Cancel</Button>
            <Button variant={fileOperation?.kind === 'delete' ? 'danger' : 'primary'} size="sm" isLoading={fileOperationBusy} onClick={() => void submitFileOperation()}>{fileOperation?.kind === 'delete' ? 'Delete' : 'Apply'}</Button>
          </div>
        </div>
      </Dialog>

      {/* Resize Handle - 与标签栏同色 */}
      {showPreview && (
        <div
          className={`
            h-1.5 cursor-row-resize shrink-0 relative
            hover:bg-accent-main-100/50 active:bg-accent-main-100 transition-colors
            ${isResizing ? 'bg-accent-main-100' : 'bg-bg-200/60'}
          `}
          onMouseDown={handleResizeStart}
          onTouchStart={handleTouchResizeStart}
        />
      )}

      {/* Preview Area */}
      {showPreview && (
        <div className="flex-1 flex flex-col min-h-0" style={{ minHeight: MIN_PREVIEW_HEIGHT }}>
          <FilePreview
            key={`${directory ?? ''}\0${previewFile?.path ?? 'file-preview'}`}
            previewFiles={previewFiles}
            path={previewFile?.path ?? null}
            targetLine={previewFile?.targetLine}
            targetKey={previewFile?.targetKey}
            targetRanges={previewFile?.targetRanges}
            content={previewContent}
            isLoading={previewLoading}
            error={previewError}
            onClose={handleClosePreview}
            onActivatePreview={handleActivatePreview}
            onClosePreview={handleClosePreviewTab}
            onReorderPreview={handleReorderPreviewTabs}
            isResizing={isAnyResizing}
            directory={directory}
            onSave={savePreview}
            onReload={loadPreview}
            editorId={`${panelTabId}:${directory ?? ''}:${previewFile?.path ?? ''}`}
          />
        </div>
      )}
    </div>
  )
})

interface TextSearchResultsProps {
  results: WorkspaceTextSearchMatch[]
  fileResults: string[]
  isLoading: boolean
  error: string | null
  onSelect: (match: WorkspaceTextSearchMatch) => void
  onSelectFile: (path: string) => void
  onContextMenuFile?: (event: React.MouseEvent, path: string, absolute?: string) => void
  directory?: string
}

const TextSearchResults = memo(function TextSearchResults({
  results,
  fileResults,
  isLoading,
  error,
  onSelect,
  onSelectFile,
  onContextMenuFile,
  directory,
}: TextSearchResultsProps) {
  const { t } = useTranslation(['components', 'common'])

  const hasFiles = fileResults.length > 0
  const hasText = results.length > 0

  // 拖拽到输入框实现 @mention，与文件树项行为一致
  const handlePointerDragStart = useCallback(
    (e: PointerEvent<HTMLButtonElement>, path: string) => {
      if (!directory) return
      const name = path.split(/[/\\]/).pop() || path
      startInternalDrag(e, {
        kind: 'file-mention',
        file: {
          type: 'file',
          path,
          absolute: toAbsolutePath(path, directory),
          name,
        },
      })
    },
    [directory],
  )

  if (isLoading && !hasFiles && !hasText) {
    return <div className="flex items-center justify-center h-20 text-text-400 text-[length:var(--fs-sm)]">{t('common:loading')}</div>
  }

  if (error && !hasFiles && !hasText) {
    return (
      <div className="flex flex-col items-center justify-center h-20 text-danger-100 text-[length:var(--fs-sm)] gap-1 px-4">
        <AlertCircleIcon size={16} />
        <span className="text-center">{error}</span>
      </div>
    )
  }

  if (!hasFiles && !hasText) {
    return (
      <div className="flex items-center justify-center h-20 text-text-400 text-[length:var(--fs-sm)]">
        {t('fileExplorer.noTextMatches')}
      </div>
    )
  }

  return (
    <div className="py-1">
      {hasFiles && (
        <>
          <div className="px-2 py-1 text-[length:var(--fs-xxs)] font-medium text-text-500 uppercase tracking-wide">
            {t('fileExplorer.fileMatches')}
          </div>
          {fileResults.map(path => {
            const name = path.split(/[/\\]/).pop() || path
            return (
              <button
                key={`file:${path}`}
                type="button"
                onPointerDown={e => handlePointerDragStart(e, path)}
                onClick={() => onSelectFile(path)}
                onContextMenu={event => onContextMenuFile?.(event, path)}
                className="w-full px-2 py-1.5 text-left hover:bg-bg-200/50 transition-colors"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <img
                    src={getMaterialIconUrl(path, 'file', false)}
                    alt=""
                    width={16}
                    height={16}
                    draggable={false}
                    className="shrink-0"
                    loading="lazy"
                    decoding="async"
                    onError={e => {
                      e.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                  <span className="truncate text-[length:var(--fs-sm)] text-text-200">{name}</span>
                </div>
                <div className="mt-0.5 truncate pl-[22px] text-[length:var(--fs-xxs)] text-text-500">{path}</div>
              </button>
            )
          })}
        </>
      )}
      {hasText && (
        <>
          {hasFiles && (
            <div className="mt-1 px-2 py-1 text-[length:var(--fs-xxs)] font-medium text-text-500 uppercase tracking-wide">
              {t('fileExplorer.contentMatches')}
            </div>
          )}
          {results.map((match, index) => {
            const path = match.path.text
            const name = path.split(/[/\\]/).pop() || path
            const line = match.lines.text.trim()

            return (
              <button
                key={`${path}:${match.line_number}:${match.absolute_offset}:${index}`}
                type="button"
                onPointerDown={e => handlePointerDragStart(e, path)}
                onClick={() => onSelect(match)}
                onContextMenu={event => onContextMenuFile?.(event, path)}
                className="w-full px-2 py-1.5 text-left hover:bg-bg-200/50 transition-colors"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <img
                    src={getMaterialIconUrl(path, 'file', false)}
                    alt=""
                    width={16}
                    height={16}
                    draggable={false}
                    className="shrink-0"
                    loading="lazy"
                    decoding="async"
                    onError={e => {
                      e.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                  <span className="truncate text-[length:var(--fs-sm)] text-text-200">{name}</span>
                  <span className="shrink-0 text-[length:var(--fs-xxs)] text-text-500">:{match.line_number}</span>
                </div>
                <div className="mt-0.5 truncate pl-[22px] font-mono text-[length:var(--fs-xxs)] text-text-400">{line}</div>
                <div className="mt-0.5 truncate pl-[22px] text-[length:var(--fs-xxs)] text-text-500">{path}</div>
              </button>
            )
          })}
        </>
      )}
      {isLoading && (
        <div className="px-2 py-1.5 text-center text-[length:var(--fs-xs)] text-text-500">{t('common:loading')}</div>
      )}
    </div>
  )
})

// ============================================
// File Tree Item
// ============================================

interface FileTreeItemProps {
  node: FileTreeNode
  depth: number
  expandedPaths: Set<string>
  fileStatus: Map<string, { status: string }>
  onClick: (node: FileTreeNode) => void
  onContextMenu?: (event: React.MouseEvent, path: string, absolute?: string, type?: 'file' | 'directory') => void
}

const FileTreeItem = memo(function FileTreeItem({
  node,
  depth,
  expandedPaths,
  fileStatus,
  onClick,
  onContextMenu,
}: FileTreeItemProps) {
  const isExpanded = expandedPaths.has(node.path)
  const isDirectory = node.type === 'directory'
  // node.path 可能用反斜杠（Windows），statusMap key 统一用正斜杠
  const status = fileStatus.get(node.path) || fileStatus.get(node.path.replace(/\\/g, '/'))

  // 状态颜色
  const statusColor = useMemo(() => {
    if (!status) return null
    switch (status.status) {
      case 'added':
        return 'text-success-100'
      case 'modified':
        return 'text-warning-100'
      case 'deleted':
        return 'text-danger-100'
      default:
        return null
    }
  }, [status])

  // 拖拽到输入框实现 @mention。使用 pointer 拖拽，避免 Tauri 原生文件 drop 接管 HTML5 DnD。
  const handlePointerDragStart = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      const fileData = {
        type: (isDirectory ? 'folder' : 'file') as 'file' | 'folder',
        path: node.path, // 相对路径
        absolute: node.absolute, // 绝对路径
        name: node.name,
      }
      startInternalDrag(e, { kind: 'file-mention', file: fileData })
    },
    [node.path, node.absolute, node.name, isDirectory],
  )

  return (
    <div>
      <button
        type="button"
        onPointerDown={handlePointerDragStart}
        onClick={() => onClick(node)}
        onContextMenu={event => onContextMenu?.(event, node.path, node.absolute, node.type === 'directory' ? 'directory' : 'file')}
        className={`
          w-full flex items-center gap-1 px-2 py-0.5 text-left cursor-default
          select-none hover:bg-bg-200/50 transition-colors text-[length:var(--fs-sm)]
          text-text-300
        `}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {/* Expand/Collapse Icon */}
        {isDirectory ? (
          <span className="w-4 h-4 flex items-center justify-center text-text-400 shrink-0">
            {isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </span>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {/* File/Folder Icon - Material Icon Theme */}
        <img
          src={getMaterialIconUrl(node.path, isDirectory ? 'directory' : 'file', isExpanded)}
          alt=""
          width={16}
          height={16}
          draggable={false}
          className="shrink-0"
          loading="lazy"
          decoding="async"
          onError={e => {
            e.currentTarget.style.visibility = 'hidden'
          }}
        />

        {/* Name */}
        <span className={`truncate flex-1 ${statusColor || ''}`}>{node.name}</span>

        {/* Loading Indicator */}
        {node.isLoading && (
          <span className="w-3 h-3 border border-text-400 border-t-transparent rounded-full animate-spin shrink-0" />
        )}
      </button>

      {/* Children */}
      {isDirectory && isExpanded && node.children && (
        <div>
          {node.children.map(child => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              fileStatus={fileStatus}
              onClick={onClick}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  )
})

// ============================================
// File Preview
// ============================================

interface FilePreviewProps {
  previewFiles: PreviewFile[]
  path: string | null
  targetLine?: number
  targetKey?: string
  targetRanges?: readonly TargetLineRange[]
  content: FileReadResponse | null
  isLoading: boolean
  error: string | null
  onClose: () => void
  onActivatePreview: (path: string) => void
  onClosePreview: (path: string) => void
  onReorderPreview: (draggedPath: string, targetPath: string) => void
  isResizing?: boolean
  directory?: string
  onSave: (path: string, text: string, etag?: string, force?: boolean) => Promise<FileReadResponse>
  onReload: (path: string) => Promise<void>
  editorId: string
}

function FilePreview({
  previewFiles,
  path,
  targetLine,
  targetKey,
  targetRanges,
  content,
  isLoading,
  error,
  onClose,
  onActivatePreview,
  onClosePreview,
  onReorderPreview,
  isResizing = false,
  directory,
  onSave,
  onReload,
  editorId,
}: FilePreviewProps) {
  const { t } = useTranslation(['components', 'common'])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [editEtag, setEditEtag] = useState<string | undefined>()
  const [saveConflict, setSaveConflict] = useState(false)

  // 获取文件名
  const fileName = path?.split(/[/\\]/).pop() || 'Untitled'
  const language = path ? detectLanguage(path) : 'text'

  const beginEditing = useCallback(() => {
    if (!content || content.type !== 'text') return
    setDraft(content.encoding === 'base64' ? decodeBase64Text(content.content) : content.content)
    setSaveError(null)
    setSaveConflict(false)
    setEditEtag(content.etag)
    setIsEditing(true)
  }, [content])

  const cancelEditing = useCallback(() => {
    setIsEditing(false)
    setSaveError(null)
  }, [])

  const saveEditing = useCallback(async (force = false) => {
    if (!path || isSaving) return
    setIsSaving(true)
    setSaveError(null)
    try {
      if (force) await onSave(path, draft, editEtag, true)
      else await onSave(path, draft, editEtag)
      setIsEditing(false)
      setSaveConflict(false)
    } catch (saveFailure) {
      setSaveError(saveFailure instanceof Error ? saveFailure.message : 'Failed to save file')
      setSaveConflict(Boolean(
        saveFailure && typeof saveFailure === 'object' && 'code' in saveFailure && saveFailure.code === 'STALE_REVISION',
      ))
    } finally {
      setIsSaving(false)
    }
  }, [draft, editEtag, isSaving, onSave, path])
  const originalText = content?.type === 'text'
    ? (content.encoding === 'base64' ? decodeBase64Text(content.content) : content.content)
    : ''
  const isDirty = isEditing && draft !== originalText
  const confirmDiscard = useCallback(() => !isDirty || window.confirm('Discard unsaved changes?'), [isDirty])

  useEffect(() => {
    setFileEditorDirty(editorId, isDirty)
    return () => setFileEditorDirty(editorId, false)
  }, [editorId, isDirty])

  useEffect(() => {
    if (!isDirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [isDirty])

  useEffect(() => {
    if (!isEditing) return
    const saveShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveEditing(false)
      }
    }
    window.addEventListener('keydown', saveShortcut)
    return () => window.removeEventListener('keydown', saveShortcut)
  }, [isEditing, saveEditing])

  // 下载当前文件
  const handleDownload = useCallback(() => {
    if (content) {
      downloadFileContent(content, fileName)
    }
  }, [content, fileName])

  const previewTabItems = useMemo<PreviewTabsBarItem[]>(
    () =>
      previewFiles.map(file => ({
        id: file.path,
        title: file.path,
        closeTitle: `${t('common:close')} ${file.name}`,
        iconPath: file.path,
        label: <span className="block whitespace-nowrap text-[length:var(--fs-xs)] font-mono">{file.name}</span>,
      })),
    [previewFiles, t],
  )

  // 处理内容类型分发
  const displayContent = useMemo(() => {
    if (!content) return null

    const category = getPreviewCategory(content.mimeType)

    if (isHtmlPreview(language, content.mimeType)) {
      return {
        type: 'html' as const,
        text: isBinaryContent(content.encoding) ? decodeBase64Text(content.content) : content.content,
      }
    }

    if (isMarkdownPreview(language, content.mimeType)) {
      const text = isBinaryContent(content.encoding) ? decodeBase64Text(content.content) : content.content
      return {
        type: 'markdown' as const,
        text,
      }
    }

    // 文本型可渲染媒体（如 SVG）— 同时提供渲染和源码
    // 优先级最高：即使以 base64 传输，也支持解码为文本查看
    if (isTextualMedia(content.mimeType)) {
      const isBase64 = isBinaryContent(content.encoding)
      const text = isBase64 ? decodeBase64Text(content.content) : content.content
      const dataUrl = isBase64
        ? buildDataUrl(content.mimeType!, content.content)
        : buildTextDataUrl(content.mimeType!, content.content)
      return {
        type: 'textMedia' as const,
        text,
        dataUrl,
        category: category!,
        mimeType: content.mimeType!,
      }
    }

    // 二进制 + 可预览的媒体类型
    if (isBinaryContent(content.encoding) && category) {
      return {
        type: 'media' as const,
        category,
        dataUrl: buildDataUrl(content.mimeType!, content.content),
        mimeType: content.mimeType!,
      }
    }

    // 二进制 + 不可预览
    if (isBinaryContent(content.encoding)) {
      return {
        type: 'binary' as const,
        mimeType: content.mimeType || 'application/octet-stream',
      }
    }

    // diff 渲染交给 Changes 面板，Files 预览只显示文件内容
    // if (content.patch && content.patch.hunks.length > 0) {
    //   return {
    //     type: 'diff' as const,
    //     hunks: content.patch.hunks,
    //   }
    // }

    // 显示文件内容
    return {
      type: 'text' as const,
      text: content.content,
    }
  }, [content, language])

  // 全屏内容
  const fullscreenContent = useMemo((): ReactNode => {
    if (!displayContent) return null
    switch (displayContent.type) {
      case 'media':
        return (
          <MediaPreview
            category={displayContent.category}
            dataUrl={displayContent.dataUrl}
            mimeType={displayContent.mimeType}
            fileName={fileName}
          />
        )
      case 'binary':
        return <BinaryPlaceholder mimeType={displayContent.mimeType} fileName={fileName} onDownload={handleDownload} />
      case 'textMedia':
        return (
          <TextMediaPreview
            key={targetKey ?? path ?? fileName}
            dataUrl={displayContent.dataUrl}
            text={displayContent.text}
            language={language || 'xml'}
            fileName={fileName}
            isResizing={false}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        )
      case 'markdown':
        return (
          <MarkdownFilePreview
            key={targetKey ?? path ?? fileName}
            text={displayContent.text}
            isResizing={false}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        )
      case 'html':
        return (
          <HtmlFilePreview
            key={targetKey ?? path ?? fileName}
            text={displayContent.text}
            fileName={fileName}
            filePath={path ?? fileName}
            directory={directory}
            isResizing={false}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        )
      case 'text':
        return (
          <CodePreview
            code={displayContent.text}
            language={language || 'text'}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        )
      default:
        return null
    }
  }, [directory, displayContent, fileName, handleDownload, language, path, targetKey, targetLine, targetRanges])

  const fullscreenHeaderRight = useMemo(
    () =>
      content ? (
        <button
          onClick={handleDownload}
          className="p-1.5 text-text-400 hover:text-text-100 hover:bg-bg-200/60 rounded-lg transition-colors"
          title={`${t('common:save')} ${fileName}`}
        >
          <DownloadIcon size={14} />
        </button>
      ) : null,
    [content, fileName, handleDownload, t],
  )

  const fullscreenLayer = useMemo(
    () =>
      fullscreenContent
        ? {
            id: `file-preview:${path || fileName}`,
            title: fileName,
            headerRight: fullscreenHeaderRight,
            content: fullscreenContent,
            deferContent: displayContent?.type === 'html',
          }
        : null,
    [displayContent?.type, fileName, fullscreenContent, fullscreenHeaderRight, path],
  )
  const { isOpen: isFullscreenOpen, open: openFullscreen } = useFullscreenLayer(fullscreenLayer)

  return (
    <div className="flex flex-col h-full relative">
      <PreviewTabsBar
        items={previewTabItems}
        activeId={path}
        closeAllTitle={t('common:closeAllTabs')}
        onActivate={nextPath => { if (confirmDiscard()) onActivatePreview(nextPath) }}
        onClose={closePath => { if (confirmDiscard()) onClosePreview(closePath) }}
        onCloseAll={() => { if (confirmDiscard()) onClose() }}
        onReorder={onReorderPreview}
        tabWidthClassName="w-auto max-w-none min-w-max"
        rightActions={
          content ? (
            <>
              {content.type === 'text' && (isEditing ? (
                <>
                  <button
                    onClick={() => void saveEditing(false)}
                    disabled={isSaving}
                    className="p-1 text-text-400 hover:text-text-100 hover:bg-bg-300/50 rounded transition-colors disabled:opacity-50"
                    title={t('common:save')}
                  >
                    <CheckIcon size={12} />
                  </button>
                  <button
                    onClick={cancelEditing}
                    disabled={isSaving}
                    className="p-1 text-text-400 hover:text-text-100 hover:bg-bg-300/50 rounded transition-colors disabled:opacity-50"
                    title={t('common:cancel')}
                  >
                    <CloseIcon size={12} />
                  </button>
                </>
              ) : (
                <button
                  onClick={beginEditing}
                  className="p-1 text-text-400 hover:text-text-100 hover:bg-bg-300/50 rounded transition-colors"
                  title="Edit"
                >
                  <PencilIcon size={12} />
                </button>
              ))}
              <button
                onClick={openFullscreen}
                className="p-1 text-text-400 hover:text-text-100 hover:bg-bg-300/50 rounded transition-colors"
                title={t('contentBlock.fullscreen')}
              >
                <MaximizeIcon size={12} />
              </button>
              <button
                onClick={handleDownload}
                className="p-1 text-text-400 hover:text-text-100 hover:bg-bg-300/50 rounded transition-colors"
                title={`${t('common:save')} ${fileName}`}
              >
                <DownloadIcon size={12} />
              </button>
            </>
          ) : null
        }
      />

      {/* Preview Content */}
      <div ref={scrollRef} className="flex-1 overflow-auto panel-scrollbar">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">
            {t('common:loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full text-danger-100 text-[length:var(--fs-sm)] gap-1 px-4">
            <AlertCircleIcon size={16} />
            <span className="text-center">{error}</span>
          </div>
        ) : isEditing ? (
          <div className="min-h-full flex flex-col">
            {saveError && (
              <div className="px-3 py-2 text-danger-100 text-[length:var(--fs-xs)] flex items-center justify-between gap-3">
                <span>{saveError}</span>
                {saveConflict ? (
                  <span className="flex gap-2 shrink-0">
                    <button className="text-text-200 hover:text-text-100" onClick={() => { if (path) { setIsEditing(false); void onReload(path) } }}>Reload</button>
                    <button className="text-danger-100 hover:text-danger-200" onClick={() => void saveEditing(true)}>Overwrite</button>
                  </span>
                ) : null}
              </div>
            )}
            <CodePreview
              code={draft}
              language={language || 'text'}
              isResizing={isResizing}
              readOnly={false}
              onChange={setDraft}
            />
          </div>
        ) : displayContent?.type === 'media' ? (
          <MediaPreview
            category={displayContent.category}
            dataUrl={displayContent.dataUrl}
            mimeType={displayContent.mimeType}
            fileName={fileName}
          />
        ) : displayContent?.type === 'binary' ? (
          <BinaryPlaceholder mimeType={displayContent.mimeType} fileName={fileName} onDownload={handleDownload} />
        ) : displayContent?.type === 'textMedia' ? (
          <TextMediaPreview
            key={targetKey ?? path ?? fileName}
            dataUrl={displayContent.dataUrl}
            text={displayContent.text}
            language={language || 'xml'}
            fileName={fileName}
            isResizing={isResizing}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        ) : displayContent?.type === 'markdown' ? (
          <MarkdownFilePreview
            key={targetKey ?? path ?? fileName}
            text={displayContent.text}
            isResizing={isResizing}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        ) : displayContent?.type === 'html' ? (
          isFullscreenOpen ? null : (
            <HtmlFilePreview
              key={targetKey ?? path ?? fileName}
              text={displayContent.text}
              fileName={fileName}
              filePath={path ?? fileName}
              directory={directory}
              isResizing={isResizing}
              targetLine={targetLine}
              targetKey={targetKey}
              targetRanges={targetRanges}
            />
          )
        ) : // diff 渲染已移至 Changes 面板
        // ) : displayContent?.type === 'diff' ? (
        //   <DiffPreview hunks={displayContent.hunks} isResizing={isResizing} />
        displayContent?.type === 'text' ? (
          <CodePreview
            code={displayContent.text}
            language={language || 'text'}
            isResizing={isResizing}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">
            {t('common:noContent')}
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================
// Media Preview - 路由到具体渲染器
// ============================================

interface MediaPreviewProps {
  category: PreviewCategory
  dataUrl: string
  mimeType: string
  fileName: string
}

function MediaPreview({ category, dataUrl, mimeType, fileName }: MediaPreviewProps) {
  switch (category) {
    case 'image':
      return <ImagePreview dataUrl={dataUrl} fileName={fileName} />
    case 'audio':
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
          <div className="text-text-400 text-[length:var(--fs-sm)]">{formatMimeType(mimeType)}</div>
          <audio controls src={dataUrl} className="w-full max-w-xs" />
        </div>
      )
    case 'video':
      return (
        <div className="flex items-center justify-center h-full p-4">
          <video controls src={dataUrl} className="max-w-full max-h-full rounded" />
        </div>
      )
    case 'pdf':
      return <iframe src={dataUrl} title={fileName} className="w-full h-full border-0" />
  }
}

// ============================================
// Image Preview - 缩放 + 拖拽平移
// 直接滚轮缩放（以鼠标为锚点），左键拖拽平移
// ============================================

const MIN_ZOOM = 0.05
const MAX_ZOOM = 20
const ZOOM_FACTOR = 1.15 // 每次滚轮的缩放倍率

interface ImagePreviewProps {
  dataUrl: string
  fileName: string
}

function ImagePreview({ dataUrl, fileName }: ImagePreviewProps) {
  const { t } = useTranslation(['components', 'common'])
  const containerRef = useRef<HTMLDivElement>(null)
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 })
  const scaleRef = useRef(1) // 同步访问，避免 stale closure
  const [scale, setScale] = useState(1)
  const [fitScale, setFitScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [initialized, setInitialized] = useState(false)
  const dragRef = useRef({ active: false, startX: 0, startY: 0 })

  // fit-to-container scale
  const computeFitScale = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !naturalSize.w || !naturalSize.h) return 1
      const rect = el.getBoundingClientRect()
      return Math.min(rect.width / naturalSize.w, rect.height / naturalSize.h, 1)
    },
    [naturalSize],
  )

  // 图片加载后初始化
  useEffect(() => {
    const container = containerRef.current
    if (!container || !naturalSize.w || !naturalSize.h) return

    const updateFitScale = () => {
      const nextFitScale = computeFitScale(container)
      setFitScale(nextFitScale)

      if (!initialized) {
        scaleRef.current = nextFitScale
        setScale(nextFitScale)
        setTranslate({ x: 0, y: 0 })
        setInitialized(true)
      }
    }

    updateFitScale()

    const resizeObserver = new ResizeObserver(updateFitScale)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [naturalSize, initialized, computeFitScale])

  // 滚轮缩放 — 以鼠标位置为锚点
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      // 鼠标相对容器中心
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      const factor = e.deltaY > 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR
      const oldScale = scaleRef.current
      const newScale = Math.min(Math.max(oldScale * factor, MIN_ZOOM), MAX_ZOOM)
      const ratio = newScale / oldScale
      scaleRef.current = newScale
      setScale(newScale)
      setTranslate(t => ({
        x: cx - ratio * (cx - t.x),
        y: cy - ratio * (cy - t.y),
      }))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  // 拖拽平移
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.active) return
      const dx = e.clientX - dragRef.current.startX
      const dy = e.clientY - dragRef.current.startY
      dragRef.current.startX = e.clientX
      dragRef.current.startY = e.clientY
      setTranslate(t => ({ x: t.x + dx, y: t.y + dy }))
    }
    const onUp = () => {
      if (dragRef.current.active) {
        dragRef.current.active = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY }
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }, [])

  const zoomIn = useCallback(() => {
    const s = Math.min(scaleRef.current * 1.25, MAX_ZOOM)
    scaleRef.current = s
    setScale(s)
  }, [])

  const zoomOut = useCallback(() => {
    const s = Math.max(scaleRef.current / 1.25, MIN_ZOOM)
    scaleRef.current = s
    setScale(s)
  }, [])

  const zoomFit = useCallback(() => {
    scaleRef.current = fitScale
    setScale(fitScale)
    setTranslate({ x: 0, y: 0 })
  }, [fitScale])

  const zoomActual = useCallback(() => {
    scaleRef.current = 1
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [])

  const isFit = Math.abs(scale - fitScale) < 0.001 && translate.x === 0 && translate.y === 0
  const isActual = Math.abs(scale - 1) < 0.001 && translate.x === 0 && translate.y === 0

  return (
    <div className="flex flex-col h-full">
      {/* Zoom toolbar */}
      <div className="shrink-0 flex items-center justify-center gap-1.5 px-2 py-1 border-b border-border-100/30 bg-bg-100/50 text-[length:var(--fs-xxs)]">
        <button
          onClick={zoomOut}
          className="px-1.5 py-0.5 rounded hover:bg-bg-200 text-text-300 hover:text-text-100 transition-colors"
        >
          −
        </button>
        <span className="w-10 text-center text-text-400 tabular-nums">{Math.round(scale * 100)}%</span>
        <button
          onClick={zoomIn}
          className="px-1.5 py-0.5 rounded hover:bg-bg-200 text-text-300 hover:text-text-100 transition-colors"
        >
          +
        </button>
        <span className="w-px h-3 bg-border-200 mx-1" />
        <button
          onClick={zoomFit}
          className={`px-1.5 py-0.5 rounded transition-colors ${isFit ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('fileExplorer.fit')}
        </button>
        <button
          onClick={zoomActual}
          className={`px-1.5 py-0.5 rounded transition-colors ${isActual ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('fileExplorer.oneToOne')}
        </button>
      </div>
      {/* Image area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
      >
        <img
          src={dataUrl}
          alt={fileName}
          draggable={false}
          className="absolute left-1/2 top-1/2 select-none"
          style={{
            transform: `translate(-50%, -50%) translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transformOrigin: 'center center',
          }}
          onLoad={e => {
            setNaturalSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }}
        />
      </div>
    </div>
  )
}

// ============================================
// Text Media Preview - 文本型可渲染媒体（如 SVG）
// 支持 Preview / Code 两种视图切换
// ============================================

interface TextMediaPreviewProps {
  dataUrl: string
  text: string
  language: string
  fileName: string
  isResizing?: boolean
  targetLine?: number
  targetKey?: string
  targetRanges?: readonly TargetLineRange[]
}

function TextMediaPreview({
  dataUrl,
  text,
  language,
  fileName,
  isResizing = false,
  targetLine,
  targetKey,
  targetRanges,
}: TextMediaPreviewProps) {
  const { t } = useTranslation(['components', 'common'])
  const [mode, setMode] = useState<'preview' | 'code'>(targetLine ? 'code' : 'preview')

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-border-100/30 bg-bg-100/50 text-[length:var(--fs-xxs)]">
        <button
          onClick={() => setMode('preview')}
          className={`px-2 py-0.5 rounded transition-colors ${mode === 'preview' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:preview')}
        </button>
        <button
          onClick={() => setMode('code')}
          className={`px-2 py-0.5 rounded transition-colors ${mode === 'code' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:code')}
        </button>
      </div>
      {/* Content */}
      {mode === 'preview' ? (
        <ImagePreview dataUrl={dataUrl} fileName={fileName} />
      ) : (
        <div className="flex-1 min-h-0">
          <CodePreview
            code={text}
            language={language}
            isResizing={isResizing}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        </div>
      )}
    </div>
  )
}

interface HtmlFilePreviewProps {
  text: string
  fileName: string
  filePath: string
  directory?: string
  isResizing?: boolean
  targetLine?: number
  targetKey?: string
  targetRanges?: readonly TargetLineRange[]
}

function HtmlFilePreview({
  text,
  fileName,
  filePath,
  directory,
  isResizing = false,
  targetLine,
  targetKey,
  targetRanges,
}: HtmlFilePreviewProps) {
  const { t } = useTranslation(['components', 'common'])
  const [mode, setMode] = useState<'preview' | 'code'>(targetLine ? 'code' : 'preview')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border-100/30 bg-bg-100/50 px-2 py-1 text-[length:var(--fs-xxs)]">
        <button
          type="button"
          onClick={() => setMode('preview')}
          className={`rounded px-2 py-0.5 transition-colors ${mode === 'preview' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:preview')}
        </button>
        <button
          type="button"
          onClick={() => setMode('code')}
          className={`rounded px-2 py-0.5 transition-colors ${mode === 'code' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:code')}
        </button>
      </div>
      {mode === 'preview' ? (
        <div className="min-h-0 flex-1">
          <HtmlFilePreviewFrame
            html={text}
            title={fileName}
            filePath={filePath}
            directory={directory}
            isResizing={isResizing}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <CodePreview
            code={text}
            language="html"
            isResizing={isResizing}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        </div>
      )}
    </div>
  )
}

interface MarkdownFilePreviewProps {
  text: string
  isResizing?: boolean
  targetLine?: number
  targetKey?: string
  targetRanges?: readonly TargetLineRange[]
}

function MarkdownFilePreview({ text, isResizing = false, targetLine, targetKey, targetRanges }: MarkdownFilePreviewProps) {
  const { t } = useTranslation(['components', 'common'])
  const [mode, setMode] = useState<'preview' | 'code'>(targetLine ? 'code' : 'preview')

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-border-100/30 bg-bg-100/50 text-[length:var(--fs-xxs)]">
        <button
          onClick={() => setMode('preview')}
          className={`px-2 py-0.5 rounded transition-colors ${mode === 'preview' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:preview')}
        </button>
        <button
          onClick={() => setMode('code')}
          className={`px-2 py-0.5 rounded transition-colors ${mode === 'code' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:code')}
        </button>
      </div>

      {mode === 'preview' ? (
        <div className="flex-1 min-h-0 overflow-auto panel-scrollbar px-5 py-4">
          <MarkdownRenderer content={text} />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <CodePreview
            code={text}
            language="markdown"
            isResizing={isResizing}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        </div>
      )}
    </div>
  )
}

// ============================================
// Binary Placeholder - 不可预览的二进制文件
// ============================================

interface BinaryPlaceholderProps {
  mimeType: string
  fileName: string
  onDownload?: () => void
}

function BinaryPlaceholder({ mimeType, fileName, onDownload }: BinaryPlaceholderProps) {
  const { t } = useTranslation(['components', 'common'])

  return (
    <div className="flex flex-col items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)] gap-2 p-4">
      <img
        src={getMaterialIconUrl(fileName, 'file')}
        alt=""
        width={32}
        height={32}
        className="opacity-50"
        onError={e => {
          e.currentTarget.style.visibility = 'hidden'
        }}
      />
      <span className="font-medium text-text-300">{fileName}</span>
      <span>{formatMimeType(mimeType)}</span>
      <span className="text-text-500 text-[length:var(--fs-xxs)]">{t('components:fileExplorer.binaryFile')}</span>
      {onDownload && (
        <button
          onClick={onDownload}
          className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-bg-200 hover:bg-bg-300 text-text-200 rounded transition-colors text-[length:var(--fs-xs)]"
        >
          <DownloadIcon size={12} />
          {t('common:download')}
        </button>
      )}
    </div>
  )
}

// ============================================
// Diff Preview
// ============================================

interface DiffPreviewProps {
  hunks: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }>
  isResizing?: boolean
}

// 当前未在 Files 预览中使用，保留供 Changes 面板等复用
export function DiffPreview({ hunks, isResizing = false }: DiffPreviewProps) {
  return (
    <div
      className={`font-mono text-[length:var(--fs-code)] leading-relaxed ${isResizing ? 'whitespace-pre overflow-hidden' : ''}`}
      style={{ contain: 'content' }}
    >
      {hunks.map((hunk, hunkIdx) => (
        <div key={hunkIdx} className="border-b border-border-100/30 last:border-0">
          {/* Hunk Header */}
          <div className="px-3 py-1 bg-bg-200/50 text-text-400 text-[length:var(--fs-xxs)]">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </div>
          {/* Lines */}
          <div>
            {hunk.lines.map((line, lineIdx) => {
              const type = line[0]
              let bgClass = ''
              let textClass = 'text-text-300'

              if (type === '+') {
                bgClass = 'bg-success-100/10'
                textClass = 'text-success-100'
              } else if (type === '-') {
                bgClass = 'bg-danger-100/10'
                textClass = 'text-danger-100'
              }

              return (
                <div key={lineIdx} className={`px-3 py-0.5 ${bgClass} ${textClass}`}>
                  <span className="select-none opacity-50 w-4 inline-block">{type || ' '}</span>
                  <span>{line.slice(1)}</span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
