import { lazy, memo, Suspense, useCallback, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useLayoutStore, layoutStore, type PanelTab } from '../store/layoutStore'
import { PanelContainer } from './PanelContainer'
import { ResizablePanel } from './ui/ResizablePanel'
import { normalizeToForwardSlash } from '../utils'
import { useChatViewport } from '../features/chat/chatViewport'

const SessionChangesPanel = lazy(() =>
  import('./SessionChangesPanel').then(module => ({ default: module.SessionChangesPanel })),
)
const FileExplorer = lazy(() => import('./FileExplorer').then(module => ({ default: module.FileExplorer })))
const SkillPanel = lazy(() => import('./SkillPanel').then(module => ({ default: module.SkillPanel })))
const ExtensionsPanel = lazy(() => import('./ExtensionsPanel').then(module => ({ default: module.ExtensionsPanel })))
const SessionTreePanel = lazy(() =>
  import('./SessionTreePanel').then(module => ({ default: module.SessionTreePanel })),
)

function PanelFallback() {
  const { t } = useTranslation(['components', 'common'])
  return (
    <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">
      {t('rightPanel.loadingPanel')}
    </div>
  )
}

interface RightPanelProps {
  directory?: string
  sessionId?: string | null
  inline?: boolean
  renderPanelContent?: boolean
  onNavigateSession?: (session: { id: string; directory?: string }) => void
  onNewChat?: () => void
}

export const RightPanel = memo(function RightPanel({
  directory,
  sessionId,
  inline = false,
  renderPanelContent = true,
  onNavigateSession,
  onNewChat,
}: RightPanelProps) {
  const { t } = useTranslation(['components', 'common'])
  const { rightPanelOpen, rightPanelWidth } = useLayoutStore()
  const { interaction, layout } = useChatViewport()
  const normalizedDirectory = directory ? normalizeToForwardSlash(directory) : undefined

  // 追踪面板 resize 状态
  const [isPanelResizing, setIsPanelResizing] = useState(false)
  useEffect(() => {
    const onStart = () => setIsPanelResizing(true)
    const onEnd = () => setIsPanelResizing(false)
    window.addEventListener('panel-resize-start', onStart)
    window.addEventListener('panel-resize-end', onEnd)
    return () => {
      window.removeEventListener('panel-resize-start', onStart)
      window.removeEventListener('panel-resize-end', onEnd)
    }
  }, [])

  // 渲染内容
  const renderContent = useCallback(
    (activeTab: PanelTab | null) => {
      if (!activeTab) {
        return (
          <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">
            {t('common:noContent')}
          </div>
        )
      }

      return (
        <>
          {/* Keep files mounted so expanded folders and previews survive tab switches. */}
          <div className={activeTab.type === 'files' ? 'h-full' : 'hidden'}>
            <Suspense fallback={<PanelFallback />}>
              <FilesContent
                activeTab={activeTab}
                directory={normalizedDirectory}
                isPanelResizing={isPanelResizing}
                sessionId={sessionId}
              />
            </Suspense>
          </div>

          {sessionId ? (
            <div className={activeTab.type === 'changes' ? 'h-full' : 'hidden'}>
              <Suspense fallback={<PanelFallback />}>
                <ChangesContent
                  activeTab={activeTab}
                  directory={normalizedDirectory}
                  sessionId={sessionId}
                  isPanelResizing={isPanelResizing}
                />
              </Suspense>
            </div>
          ) : activeTab.type === 'changes' ? (
            <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">
              {t('rightPanel.noActiveSession')}
            </div>
          ) : null}

          {activeTab.type === 'extensions' ? (
            <Suspense fallback={<PanelFallback />}>
              <ExtensionsPanel sessionId={sessionId ?? null} />
            </Suspense>
          ) : null}

          {activeTab.type === 'skill' ? (
            <Suspense fallback={<PanelFallback />}>
              <SkillPanel isResizing={isPanelResizing} sessionId={sessionId} />
            </Suspense>
          ) : null}

          {activeTab.type === 'session-tree' ? (
            sessionId ? (
              <Suspense fallback={<PanelFallback />}>
                <SessionTreePanel
                  sessionId={sessionId}
                  onNavigateSession={onNavigateSession}
                  onNewChat={onNewChat}
                />
              </Suspense>
            ) : (
              <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)] px-4 text-center">
                {t('rightPanel.noActiveSession')}
              </div>
            )
          ) : null}

          {activeTab.type === 'session-controls' ? (
            sessionId ? (
              <Suspense fallback={<PanelFallback />}>
                <SessionTreePanel
                  sessionId={sessionId}
                  mode="controls"
                  onNavigateSession={onNavigateSession}
                  onNewChat={onNewChat}
                />
              </Suspense>
            ) : (
              <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)] px-4 text-center">
                {t('rightPanel.noActiveSession')}
              </div>
            )
          ) : null}
        </>
      )
    },
    [normalizedDirectory, sessionId, isPanelResizing, t, onNavigateSession],
  )

  if (inline) {
    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-bg-100 [contain:layout_paint]">
        {renderPanelContent ? (
          <PanelContainer
            position="right"
            forceOpen
          >
            {renderContent}
          </PanelContainer>
        ) : null}
      </div>
    )
  }

  return (
    <ResizablePanel
      position="right"
      isOpen={rightPanelOpen}
      overlay={interaction.rightPanelBehavior === 'overlay'}
      size={layout.rightPanel.dockedWidth || rightPanelWidth}
      minSize={layout.rightPanel.hardMinWidth}
      maxSize={layout.rightPanel.resizeMaxWidth}
      onSizeChange={w => layoutStore.setRightPanelWidth(w)}
      onClose={() => layoutStore.closeRightPanel()}
    >
      <PanelContainer
        position="right"
      >
        {renderContent}
      </PanelContainer>
    </ResizablePanel>
  )
})

interface FilesContentProps {
  activeTab: PanelTab
  directory?: string
  isPanelResizing?: boolean
  sessionId?: string | null
}

const FilesContent = memo(function FilesContent({
  activeTab,
  directory,
  isPanelResizing = false,
  sessionId,
}: FilesContentProps) {
  const { panelTabs } = useLayoutStore()
  const fileTabs = panelTabs.filter(t => t.position === 'right' && t.type === 'files')

  return (
    <>
      {fileTabs.map(tab => (
        <div key={tab.id} className={tab.id === activeTab.id ? 'h-full' : 'hidden'}>
          <FileExplorer
            panelTabId={tab.id}
            directory={directory}
            previewFile={tab.previewFile ?? null}
            previewFiles={tab.previewFiles ?? []}
            position="right"
            isPanelResizing={isPanelResizing}
            sessionId={sessionId}
          />
        </div>
      ))}
    </>
  )
})

interface ChangesContentProps {
  activeTab: PanelTab
  directory?: string
  sessionId: string
  isPanelResizing?: boolean
}

const ChangesContent = memo(function ChangesContent({
  activeTab,
  directory,
  sessionId,
  isPanelResizing = false,
}: ChangesContentProps) {
  const { panelTabs } = useLayoutStore()
  const changeTabs = panelTabs.filter(t => t.position === 'right' && t.type === 'changes')

  return (
    <>
      {changeTabs.map(tab => (
        <div key={tab.id} className={tab.id === activeTab.id ? 'h-full' : 'hidden'}>
          <SessionChangesPanel
            sessionId={sessionId}
            directory={directory}
            position="right"
            isResizing={isPanelResizing}
          />
        </div>
      ))}
    </>
  )
})
