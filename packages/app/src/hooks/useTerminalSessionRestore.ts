import { useEffect, useRef, useState } from 'react'
import { serverStore } from '../store/serverStore'
import { layoutStore } from '../store/layoutStore'
import { listHostTerminals } from '../pi/transport/index.js'
import { normalizeToForwardSlash, uiErrorHandler } from '../utils'

/**
 * 同步当前 workspace 的终端列表，并在 workspace 切换或服务端变化后重建
 * terminal tabs。底部和右侧面板共享同一份恢复逻辑，保证切换 workspace 时
 * 两个面板都不会用旧终端 id 去连接新 workspace。
 */
export function useTerminalSessionRestore(directory?: string) {
  const normalizedDirectory = directory ? normalizeToForwardSlash(directory) : undefined
  const [isRestoring, setIsRestoring] = useState(false)
  const previousDirectoryRef = useRef<string | undefined>(undefined)
  const restoreRequestIdRef = useRef(0)

  useEffect(() => {
    if (previousDirectoryRef.current === normalizedDirectory && restoreRequestIdRef.current > 0) return
    previousDirectoryRef.current = normalizedDirectory

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
        const result = await listHostTerminals(normalizedDirectory)
        if (restoreRequestIdRef.current !== requestId) return
        layoutStore.syncTerminalSessions(normalizedDirectory, result.terminals)
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
    return serverStore.onServerChange(() => {
      void restoreSessions(++restoreRequestIdRef.current)
    })
  }, [normalizedDirectory])

  return { isRestoring, normalizedDirectory }
}
