/**
 * PaneHeader — Compact header bar for each split pane.
 *
 * Shows: session title (editable) | split H | split V | close
 * Supports drag-to-swap via native drag & drop between pane headers.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CloseIcon,
  SplitHorizontalIcon,
  SplitVerticalIcon,
  PanelBottomIcon,
  PanelRightIcon,
  SidebarIcon,
  MaximizeIcon,
  MinimizeIcon,
} from '../../components/Icons'
import { IconButton } from '../../components/ui'
import { paneLayoutStore } from '../../store/paneLayoutStore'
import { layoutStore, useLayoutStore } from '../../store/layoutStore'
import { usePiSessionTitle } from '../../pi/hooks/index.js'
import { renamePiSession, loadPiSessions } from '../../pi/controllers/index.js'
import { uiErrorHandler } from '../../utils'
import { useChatViewport, canUseSplitPane } from './chatViewport'
import { usePiCapabilities } from '../../pi/capabilities'
import {
  getInternalDragSnapshot,
  isPointInsideElement,
  startInternalDrag,
  subscribeInternalDrag,
  subscribeInternalDrop,
} from '../../lib/internalDragCore'

interface PaneHeaderProps {
  paneId: string
  sessionId: string | null
  isFocused: boolean
  paneCount: number
  canSplitPane?: boolean
  isPaneFullscreen?: boolean
  showSidebarButton?: boolean
  onOpenSidebar?: () => void
  onToggleRightPanel?: () => void
  onTogglePaneFullscreen?: () => void
  onFocus: () => void
}

export function PaneHeader({
  paneId,
  sessionId,
  isFocused,
  paneCount,
  canSplitPane,
  isPaneFullscreen = false,
  showSidebarButton = false,
  onOpenSidebar,
  onToggleRightPanel,
  onTogglePaneFullscreen,
  onFocus,
}: PaneHeaderProps) {
  const { t } = useTranslation('chat')
  const viewport = useChatViewport()
  const canRename = usePiCapabilities().sessionRename
  const sessionTitle = usePiSessionTitle(sessionId)
  const { rightPanelOpen, bottomPanelOpen } = useLayoutStore()
  const [isEditing, setIsEditing] = useState(false)

  // 会话切换时重置编辑状态（渲染期间调整 state，避免 effect 级联渲染）
  const [editSessionId, setEditSessionId] = useState(sessionId)
  if (sessionId !== editSessionId) {
    setEditSessionId(sessionId)
    setIsEditing(false)
  }
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)

  // Drag state for swap
  const [isDragOver, setIsDragOver] = useState(false)

  const title = sessionTitle || t('header.newChat')
  const splitEnabled = canSplitPane ?? canUseSplitPane(viewport)

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleStartEdit = useCallback(() => {
    if (!sessionId || !canRename) return
    setEditValue(title)
    setIsEditing(true)
  }, [canRename, sessionId, title])

  const handleRename = useCallback(async () => {
    if (!sessionId || !editValue.trim() || editValue === title) {
      setIsEditing(false)
      return
    }
    try {
      await renamePiSession(sessionId, editValue.trim())
      void loadPiSessions().catch(() => undefined)
    } catch (e) {
      uiErrorHandler('rename session', e)
    } finally {
      setIsEditing(false)
    }
  }, [sessionId, editValue, title])

  // ---- Split actions ----
  const handleSplitH = useCallback(() => {
    paneLayoutStore.splitPane(paneId, 'horizontal')
  }, [paneId])

  const handleSplitV = useCallback(() => {
    paneLayoutStore.splitPane(paneId, 'vertical')
  }, [paneId])

  const handleClose = useCallback(() => {
    paneLayoutStore.closePane(paneId)
  }, [paneId])

  // ---- Drag & Drop (swap panes) ----
  const handlePointerDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      if (target.closest('button, input')) return
      startInternalDrag(
        e,
        { kind: 'pane', paneId },
      )
    },
    [paneId],
  )

  useEffect(() => {
    return subscribeInternalDrag(() => {
      const active = getInternalDragSnapshot().active
      setIsDragOver(
        Boolean(
          active?.payload.kind === 'pane' &&
            active.payload.paneId !== paneId &&
            isPointInsideElement(active.current, headerRef.current),
        ),
      )
    })
  }, [paneId])

  useEffect(() => {
    return subscribeInternalDrop(event => {
      if (event.payload.kind !== 'pane') return
      setIsDragOver(false)
      if (event.payload.paneId !== paneId && isPointInsideElement(event.point, headerRef.current)) {
        paneLayoutStore.swapPanes(event.payload.paneId, paneId)
      }
    })
  }, [paneId])

  return (
    <div
      ref={headerRef}
      className={`relative mobile-safe-topbar-10 flex items-center justify-between px-2 select-none transition-colors duration-200 shrink-0 z-20 ${
        isDragOver ? 'bg-accent-main-100/10' : 'bg-bg-100'
      }`}
      onClick={onFocus}
      onPointerDown={handlePointerDragStart}
    >
      {/* Left: Title */}
      <div className="flex items-center min-w-0 flex-1">
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => {
              if (e.key === 'Enter') handleRename()
              if (e.key === 'Escape') setIsEditing(false)
            }}
            className="px-1.5 py-0.5 text-[length:var(--fs-sm)] font-medium text-text-100 bg-transparent border-none outline-none w-[140px]"
          />
        ) : canRename ? (
          <button
            onClick={handleStartEdit}
            className="px-1.5 py-0.5 text-[length:var(--fs-sm)] font-medium text-text-200 hover:text-text-100 transition-colors truncate max-w-[200px] cursor-text select-none"
            title={t('header.clickToRename')}
          >
            {title}
          </button>
        ) : (
          <span className="px-1.5 py-0.5 text-[length:var(--fs-sm)] font-medium text-text-200 truncate max-w-[200px] select-none">
            {title}
          </span>
        )}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <div className="flex items-center gap-0.5 shrink-0">
          {paneCount > 1 && (
            <IconButton
              size="sm"
              aria-label={t('header.closePane')}
              onClick={e => {
                e.stopPropagation()
                handleClose()
              }}
              className="text-text-300 hover:text-danger-100 hover:bg-bg-200/50"
            >
              <CloseIcon size={14} />
            </IconButton>
          )}

          {isFocused && onTogglePaneFullscreen && (
            <IconButton
              size="sm"
              aria-label={isPaneFullscreen ? t('header.exitFullscreenPane') : t('header.fullscreenPane')}
              onClick={e => {
                e.stopPropagation()
                onTogglePaneFullscreen()
              }}
              className={`transition-colors ${
                isPaneFullscreen
                  ? 'text-accent-main-100 bg-bg-200/50'
                  : 'text-text-300 hover:text-text-100 hover:bg-bg-200/50'
              }`}
            >
              {isPaneFullscreen ? <MinimizeIcon size={14} /> : <MaximizeIcon size={14} />}
            </IconButton>
          )}

          {splitEnabled && (
            <>
              <IconButton
                size="sm"
                aria-label={t('header.splitHorizontal')}
                onClick={e => {
                  e.stopPropagation()
                  handleSplitH()
                }}
                className="text-text-300 hover:text-text-100 hover:bg-bg-200/50"
              >
                <SplitHorizontalIcon size={14} />
              </IconButton>

              <IconButton
                size="sm"
                aria-label={t('header.splitVertical')}
                onClick={e => {
                  e.stopPropagation()
                  handleSplitV()
                }}
                className="text-text-300 hover:text-text-100 hover:bg-bg-200/50"
              >
                <SplitVerticalIcon size={14} />
              </IconButton>
            </>
          )}
        </div>

        {isFocused && (
        <div className="flex items-center gap-1 shrink-0">
            {showSidebarButton && onOpenSidebar && (
              <IconButton
                size="sm"
                aria-label={t('header.openSidebar')}
                onClick={e => {
                  e.stopPropagation()
                  onOpenSidebar()
                }}
                className="text-text-300 hover:text-text-100 hover:bg-bg-200/50"
              >
                <SidebarIcon size={14} />
              </IconButton>
            )}

            <IconButton
              size="sm"
              aria-label={bottomPanelOpen ? t('header.closeBottomPanel') : t('header.openBottomPanel')}
              onClick={e => {
                e.stopPropagation()
                layoutStore.toggleBottomPanel()
              }}
              className={`transition-colors ${
                bottomPanelOpen
                  ? 'text-accent-main-100 bg-bg-200/50'
                  : 'text-text-300 hover:text-text-100 hover:bg-bg-200/50'
              }`}
            >
              <PanelBottomIcon size={14} />
            </IconButton>

            <IconButton
              size="sm"
              aria-label={rightPanelOpen ? t('header.closePanel') : t('header.openPanel')}
              onClick={e => {
                e.stopPropagation()
                if (onToggleRightPanel) {
                  onToggleRightPanel()
                } else {
                  layoutStore.toggleRightPanel()
                }
              }}
              className={`transition-colors ${
                rightPanelOpen
                  ? 'text-accent-main-100 bg-bg-200/50'
                  : 'text-text-300 hover:text-text-100 hover:bg-bg-200/50'
              }`}
            >
              <PanelRightIcon size={14} />
            </IconButton>
          </div>
        )}
      </div>

      <div data-chat-header-shadow className="absolute top-full left-0 right-0 h-8 bg-gradient-to-b from-bg-100 to-transparent pointer-events-none z-10" />
    </div>
  )
}
