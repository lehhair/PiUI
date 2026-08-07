import { useEffect, useRef, useState } from 'react'
import { serverStore } from '../store/serverStore'
import { layoutStore } from '../store/layoutStore'
import { listHostTerminals } from '../pi/transport/index.js'
import { resolveWorkspacePath } from '../pi/workspaces'
import { piEventStream } from '../pi/eventStream'
import { useServerStore } from './useServerStore'
import { normalizeToForwardSlash, uiErrorHandler } from '../utils'

/**
 * 同步当前 workspace 的终端列表，并在 workspace 切换或服务端变化后重建
 * terminal tabs。底部和右侧面板共享同一份恢复逻辑，保证切换 workspace 时
 * 两个面板都不会用旧终端 id 去连接新 workspace。
 */
export function useTerminalSessionRestore(directory?: string) {
  const normalizedDirectory = directory ? normalizeToForwardSlash(directory) : undefined
  const { activeServer } = useServerStore()
  const [isRestoring, setIsRestoring] = useState(false)
  const [workspacePath, setWorkspacePath] = useState<string | undefined>(undefined)
  const workspacePathRef = useRef<string | undefined>(undefined)
  const restoreRequestIdRef = useRef(0)
  // 只有首次恢复允许切换"恢复会话中"占位；后续后台刷新如果也置位，
  // 面板会把已挂载的 Terminal 卸载掉，连接一断一连造成状态闪烁
  const hasRestoredRef = useRef(false)

  useEffect(() => {
    let active = true
    workspacePathRef.current = undefined
    setWorkspacePath(undefined)
    void resolveWorkspacePath(normalizedDirectory).then(resolved => {
      if (!active || !resolved) return
      workspacePathRef.current = resolved
      setWorkspacePath(resolved)
      piEventStream.connectWorkspace(resolved)
    }).catch(() => undefined)
    return () => {
      active = false
      const resolved = workspacePathRef.current
      workspacePathRef.current = undefined
      if (resolved) piEventStream.disconnectWorkspace(resolved)
    }
  }, [activeServer?.id, activeServer?.token, activeServer?.url, normalizedDirectory])

  useEffect(() => {
    const restoreSessions = async (requestId: number) => {
      if (!hasRestoredRef.current) setIsRestoring(true)
      try {
        const workspacePath = await resolveWorkspacePath(normalizedDirectory)
        if (!workspacePath) {
          if (restoreRequestIdRef.current !== requestId) return
          layoutStore.syncTerminalSessions(undefined, [])
          return
        }
        const result = await listHostTerminals(workspacePath)
        if (restoreRequestIdRef.current !== requestId) return
        layoutStore.syncTerminalSessions(workspacePath, result.terminals)
      } catch (error) {
        if (restoreRequestIdRef.current === requestId) {
          uiErrorHandler('restore terminal sessions', error)
        }
      } finally {
        if (restoreRequestIdRef.current === requestId) {
          hasRestoredRef.current = true
          setIsRestoring(false)
        }
      }
    }

    const requestId = ++restoreRequestIdRef.current
    hasRestoredRef.current = false
    void restoreSessions(requestId)
    const onTerminalsChanged = (event: Event) => {
      const workspacePath = (event as CustomEvent<{ workspacePath?: string }>).detail?.workspacePath
      if (!workspacePath || normalizeToForwardSlash(workspacePath) !== normalizeToForwardSlash(workspacePathRef.current ?? '')) return
      void restoreSessions(++restoreRequestIdRef.current)
    }
    window.addEventListener('piui:terminals-changed', onTerminalsChanged)
    const unsubscribe = serverStore.onServerChange(() => {
      void restoreSessions(++restoreRequestIdRef.current)
    })
    return () => {
      restoreRequestIdRef.current += 1
      window.removeEventListener('piui:terminals-changed', onTerminalsChanged)
      unsubscribe()
    }
  }, [normalizedDirectory])

  return { isRestoring, normalizedDirectory, workspacePath }
}
