import { useEffect, useRef, useState } from 'react'
import { serverStore } from '../store/serverStore'
import { layoutStore } from '../store/layoutStore'
import { listHostTerminals } from '../pi/transport/index.js'
import { resolveWorkspacePath } from '../pi/workspaces'
import { normalizeToForwardSlash, uiErrorHandler } from '../utils'

/**
 * 同步当前 workspace 的终端列表，并在 workspace 切换或服务端变化后重建
 * terminal tabs。底部和右侧面板共享同一份恢复逻辑，保证切换 workspace 时
 * 两个面板都不会用旧终端 id 去连接新 workspace。
 */
export function useTerminalSessionRestore(directory?: string) {
  const normalizedDirectory = directory ? normalizeToForwardSlash(directory) : undefined
  const [isRestoring, setIsRestoring] = useState(false)
  const restoreRequestIdRef = useRef(0)

  useEffect(() => {
    const restoreSessions = async (requestId: number) => {
      setIsRestoring(true)
      if (!normalizedDirectory) {
        if (restoreRequestIdRef.current === requestId) {
          layoutStore.syncTerminalSessions(undefined, [])
          setIsRestoring(false)
        }
        return
      }

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
        if (restoreRequestIdRef.current === requestId) setIsRestoring(false)
      }
    }

    const requestId = ++restoreRequestIdRef.current
    void restoreSessions(requestId)
    const onTerminalsChanged = (event: Event) => {
      const workspacePath = (event as CustomEvent<{ workspacePath?: string }>).detail?.workspacePath
      if (!workspacePath || normalizeToForwardSlash(workspacePath) !== normalizedDirectory) return
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

  return { isRestoring, normalizedDirectory }
}
