import { lazy, memo, Suspense, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelContainer } from './PanelContainer'
import { layoutStore, useLayoutStore, type PanelTab } from '../store/layoutStore'
import { useFocusedSessionId } from '../pi/hooks/index.js'
import { ResizablePanel } from './ui/ResizablePanel'
import { useChatViewport } from '../features/chat/chatViewport'
import { createHostTerminal, listHostTerminals, removeHostTerminal, updateHostTerminal } from '../pi/transport/index.js'
import { useTerminalSessionRestore } from '../hooks/useTerminalSessionRestore'
import { resolveWorkspacePath } from '../pi/workspaces'
import { uiErrorHandler } from '../utils'
import { TerminalIcon } from './Icons'

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

interface BottomPanelProps {
  directory?: string
  onNavigateSession?: (session: { id: string; directory?: string }) => void
  onNewChat?: () => void
}

function PanelFallback() {
  const { t } = useTranslation(['components', 'common'])
  return (
    <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">{t('bottomPanel.loadingPanel')}</div>
  )
}

export const BottomPanel = memo(function BottomPanel({ directory, onNavigateSession, onNewChat }: BottomPanelProps) {
  const { t } = useTranslation(['components', 'common'])
  const { bottomPanelOpen, bottomPanelHeight } = useLayoutStore()
  const sessionId = useFocusedSessionId()
  const { interaction, layout } = useChatViewport()
  const { isRestoring, normalizedDirectory } = useTerminalSessionRestore(directory)

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

  const handleNewTerminal = useCallback(async () => {
    if (!normalizedDirectory) return
    try {
      const workspacePath = await resolveWorkspacePath(normalizedDirectory)
      if (!workspacePath) return
      const terminal = await createHostTerminal(workspacePath)
      layoutStore.addTerminalTab({
        id: terminal.id,
        title: terminal.title,
        shell: terminal.shell,
        cwd: terminal.cwd,
        status: 'connecting'
      })
    } catch (error) {
      uiErrorHandler('create terminal', error)
    }
  }, [normalizedDirectory])

  useEffect(() => {
    const handler = () => void handleNewTerminal()
    window.addEventListener('piui:new-terminal', handler)
    return () => window.removeEventListener('piui:new-terminal', handler)
  }, [handleNewTerminal])

  const handleCloseTerminal = useCallback(
    async (terminalId: string) => {
      if (!normalizedDirectory) return
      try {
        const workspacePath = await resolveWorkspacePath(normalizedDirectory)
        if (!workspacePath) return
        await removeHostTerminal(workspacePath, terminalId)
      } catch (error) {
        uiErrorHandler('close terminal', error)
        // 服务端可能仍持有该终端，重新拉取列表把 tab 恢复回来
        try {
          const workspacePath = await resolveWorkspacePath(normalizedDirectory)
          if (!workspacePath) return
          const result = await listHostTerminals(workspacePath)
          layoutStore.syncTerminalSessions(workspacePath, result.terminals)
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
      const workspacePath = await resolveWorkspacePath(normalizedDirectory)
      if (!workspacePath) return
      const terminal = await updateHostTerminal(workspacePath, terminalId, { title })
      layoutStore.updateTerminalCustomTitle(terminalId, terminal.title)
    },
    [normalizedDirectory]
  )

  // 渲染内容
  const renderContent = useCallback(
    (activeTab: PanelTab | null) => {
      if (isRestoring) {
        return (
          <div className="flex flex-col items-center justify-center h-full text-text-400 text-[length:var(--fs-base)] gap-2">
            <TerminalIcon size={24} className="opacity-30 animate-pulse" />
            <span>{t('terminal.restoringSessions')}</span>
          </div>
        )
      }

      if (!activeTab) {
        return (
          <div className="flex flex-col items-center justify-center h-full text-text-400 text-[length:var(--fs-base)] gap-2">
            <TerminalIcon size={24} className="opacity-30" />
            <span>{t('common:noContent')}</span>
            <button
              onClick={() => void handleNewTerminal()}
              className="px-3 py-1.5 text-[length:var(--fs-sm)] bg-bg-200/50 hover:bg-bg-200 text-text-200 rounded-md transition-colors"
            >
              {t('terminal.createTerminal')}
            </button>
          </div>
        )
      }

      return (
        <>
          {/* Keep files mounted so expanded folders and previews survive tab switches. */}
          <div className={activeTab.type === 'files' ? 'h-full' : 'hidden'}>
            <Suspense fallback={<PanelFallback />}>
              <FilesContent activeTab={activeTab} directory={directory ?? ''} isPanelResizing={isPanelResizing} sessionId={sessionId} />
            </Suspense>
          </div>

          {sessionId ? (
            <div className={activeTab.type === 'changes' ? 'h-full' : 'hidden'}>
              <Suspense fallback={<PanelFallback />}>
                <ChangesContent activeTab={activeTab} directory={directory} sessionId={sessionId} isPanelResizing={isPanelResizing} />
              </Suspense>
            </div>
          ) : activeTab.type === 'changes' ? (
            <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">
              {t('rightPanel.noActiveSession')}
            </div>
          ) : null}

          {activeTab.type === 'extensions' ? (
            <Suspense fallback={<PanelFallback />}>
              <ExtensionsPanel sessionId={sessionId} />
            </Suspense>
          ) : null}

          {activeTab.type === 'terminal' ? (
            <Suspense fallback={<PanelFallback />}>
              <TerminalContent activeTab={activeTab} workspacePath={normalizedDirectory} position="bottom" />
            </Suspense>
          ) : null}

          {activeTab.type === 'skill' ? (
            <Suspense fallback={<PanelFallback />}>
              <SkillPanel isResizing={isPanelResizing} sessionId={sessionId} />
            </Suspense>
          ) : null}

          {activeTab.type === 'session-tree' || activeTab.type === 'session-controls' ? (
            sessionId ? (
              <Suspense fallback={<PanelFallback />}>
                <SessionTreePanel
                  sessionId={sessionId}
                  mode={activeTab.type === 'session-controls' ? 'controls' : undefined}
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
    [directory, normalizedDirectory, sessionId, isPanelResizing, isRestoring, t, handleNewTerminal, onNavigateSession, onNewChat]
  )

  return (
    <ResizablePanel
      position="bottom"
      isOpen={bottomPanelOpen}
      overlay={interaction.bottomPanelBehavior === 'overlay'}
      overlayBackdrop={false}
      size={bottomPanelHeight}
      maxSize={layout.bottomPanel.maxHeight}
      onSizeChange={h => layoutStore.setBottomPanelHeight(h)}
      onClose={() => layoutStore.closeBottomPanel()}
    >
      <PanelContainer
        position="bottom"
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
  position: 'bottom' | 'right'
}

const TerminalContent = memo(function TerminalContent({ activeTab, workspacePath, position }: TerminalContentProps) {
  const { panelTabs } = useLayoutStore()
  const tabs = panelTabs.filter(tab => tab.position === position && tab.type === 'terminal')
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
  const fileTabs = panelTabs.filter(t => t.position === 'bottom' && t.type === 'files')

  return (
    <>
      {fileTabs.map(tab => (
        <div key={tab.id} className={tab.id === activeTab.id ? 'h-full' : 'hidden'}>
          <FileExplorer
            panelTabId={tab.id}
            directory={directory}
            previewFile={tab.previewFile ?? null}
            previewFiles={tab.previewFiles ?? []}
            position="bottom"
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
  const changeTabs = panelTabs.filter(t => t.position === 'bottom' && t.type === 'changes')

  return (
    <>
      {changeTabs.map(tab => (
        <div key={tab.id} className={tab.id === activeTab.id ? 'h-full' : 'hidden'}>
          <SessionChangesPanel sessionId={sessionId} directory={directory} position="bottom" isResizing={isPanelResizing} />
        </div>
      ))}
    </>
  )
})
