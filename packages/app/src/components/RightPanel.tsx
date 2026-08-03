import { lazy, memo, Suspense, useCallback, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useLayoutStore, layoutStore, type PanelTab } from '../store/layoutStore'
import { PanelContainer } from './PanelContainer'
import { ResizablePanel } from './ui/ResizablePanel'
import { useChatViewport } from '../features/chat/chatViewport'
import { createHostTerminal, listHostTerminals, removeHostTerminal, updateHostTerminal } from '../pi/transport/index.js'
import { useTerminalSessionRestore } from '../hooks/useTerminalSessionRestore'
import { uiErrorHandler } from '../utils'

const SessionChangesPanel = lazy(() =>
  import('./SessionChangesPanel').then(module => ({
    default: module.SessionChangesPanel
  }))
)
const FileExplorer = lazy(() => import('./FileExplorer').then(module => ({ default: module.FileExplorer })))
const SkillPanel = lazy(() => import('./SkillPanel').then(module => ({ default: module.SkillPanel })))
const ExtensionsPanel = lazy(() =>
  import('./ExtensionsPanel').then(module => ({
    default: module.ExtensionsPanel
  }))
)
const SessionTreePanel = lazy(() =>
  import('./SessionTreePanel').then(module => ({
    default: module.SessionTreePanel
  }))
)
const Terminal = lazy(() => import('./Terminal').then(module => ({ default: module.Terminal })))

function PanelFallback() {
  const { t } = useTranslation(['components', 'common'])
  return (
    <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">{t('rightPanel.loadingPanel')}</div>
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
  onNewChat
}: RightPanelProps) {
  const { t } = useTranslation(['components', 'common'])
  const { rightPanelOpen, rightPanelWidth } = useLayoutStore()
  const { interaction, layout } = useChatViewport()
  const { isRestoring, normalizedDirectory } = useTerminalSessionRestore(directory)

  const handleNewTerminal = useCallback(async () => {
    if (!normalizedDirectory) return
    try {
      const terminal = await createHostTerminal(normalizedDirectory)
      layoutStore.addTerminalTab(
        {
          id: terminal.id,
          title: terminal.title,
          shell: terminal.shell,
          cwd: terminal.cwd,
          status: 'connecting'
        },
        true,
        'right'
      )
    } catch (error) {
      uiErrorHandler('create terminal', error)
    }
  }, [normalizedDirectory])

  const handleCloseTerminal = useCallback(
    async (terminalId: string) => {
      if (!normalizedDirectory) return
      try {
        await removeHostTerminal(normalizedDirectory, terminalId)
      } catch (error) {
        uiErrorHandler('close terminal', error)
        // 服务端可能仍持有该终端，重新拉取列表把 tab 恢复回来
        try {
          const result = await listHostTerminals(normalizedDirectory)
          layoutStore.syncTerminalSessions(normalizedDirectory, result.terminals)
        } catch {
          // 列表也失败时保持现状，tab 由下次恢复流程修正
        }
      }
    },
    [normalizedDirectory]
  )

  const handleRenameTerminal = useCallback(
    async (terminalId: string, title: string) => {
      if (!normalizedDirectory) return
      const terminal = await updateHostTerminal(normalizedDirectory, terminalId, { title })
      layoutStore.updateTerminalCustomTitle(terminalId, terminal.title)
    },
    [normalizedDirectory]
  )

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
      if (isRestoring) {
        return (
          <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">
            {t('terminal.restoringSessions')}
          </div>
        )
      }

      if (!activeTab) {
        return (
          <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">{t('common:noContent')}</div>
        )
      }

      return (
        <>
          {/* Keep files mounted so expanded folders and previews survive tab switches. */}
          <div className={activeTab.type === 'files' ? 'h-full' : 'hidden'}>
            <Suspense fallback={<PanelFallback />}>
              <FilesContent activeTab={activeTab} directory={normalizedDirectory} isPanelResizing={isPanelResizing} sessionId={sessionId} />
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
                <SessionTreePanel sessionId={sessionId} onNavigateSession={onNavigateSession} onNewChat={onNewChat} />
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
                <SessionTreePanel sessionId={sessionId} mode="controls" onNavigateSession={onNavigateSession} onNewChat={onNewChat} />
              </Suspense>
            ) : (
              <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)] px-4 text-center">
                {t('rightPanel.noActiveSession')}
              </div>
            )
          ) : null}

          {activeTab.type === 'terminal' ? (
            <Suspense fallback={<PanelFallback />}>
              <TerminalContent activeTab={activeTab} workspacePath={normalizedDirectory} />
            </Suspense>
          ) : null}
        </>
      )
    },
    [normalizedDirectory, isRestoring, sessionId, isPanelResizing, t, onNavigateSession, onNewChat]
  )

  if (inline) {
    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-bg-100 [contain:layout_paint]">
        {renderPanelContent ? (
          <PanelContainer
            position="right"
            forceOpen
            onNewTerminal={handleNewTerminal}
            onCloseTerminal={handleCloseTerminal}
            onRenameTerminal={handleRenameTerminal}
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
        onNewTerminal={handleNewTerminal}
        onCloseTerminal={handleCloseTerminal}
        onRenameTerminal={handleRenameTerminal}
      >
        {renderContent}
      </PanelContainer>
    </ResizablePanel>
  )
})

interface TerminalContentProps {
  activeTab: PanelTab
  workspacePath?: string
}

const TerminalContent = memo(function TerminalContent({ activeTab, workspacePath }: TerminalContentProps) {
  const { panelTabs } = useLayoutStore()
  const tabs = panelTabs.filter(tab => tab.position === 'right' && tab.type === 'terminal')
  return (
    <>
      {tabs.map(tab => (
        <Terminal key={tab.id} terminalId={tab.terminalId ?? tab.id} workspacePath={workspacePath} isActive={tab.id === activeTab.id} />
      ))}
    </>
  )
})

interface FilesContentProps {
  activeTab: PanelTab
  directory?: string
  isPanelResizing?: boolean
  sessionId?: string | null
}

const FilesContent = memo(function FilesContent({ activeTab, directory, isPanelResizing = false, sessionId }: FilesContentProps) {
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

const ChangesContent = memo(function ChangesContent({ activeTab, directory, sessionId, isPanelResizing = false }: ChangesContentProps) {
  const { panelTabs } = useLayoutStore()
  const changeTabs = panelTabs.filter(t => t.position === 'right' && t.type === 'changes')

  return (
    <>
      {changeTabs.map(tab => (
        <div key={tab.id} className={tab.id === activeTab.id ? 'h-full' : 'hidden'}>
          <SessionChangesPanel sessionId={sessionId} directory={directory} position="right" isResizing={isPanelResizing} />
        </div>
      ))}
    </>
  )
})
