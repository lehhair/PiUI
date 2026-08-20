import { useEffect, useRef, useState } from 'react'
import { serverStore } from '../store/serverStore'
import { layoutStore } from '../store/layoutStore'
import { listHostTerminals } from '../pi/transport/index.js'
import { resolveWorkspacePath } from '../pi/workspaces'
import { piEventStream } from '../pi/eventStream'
import { useServerStore } from './useServerStore'
import { usePiBackendState } from '../pi/serverMode'
import { normalizeToForwardSlash, uiErrorHandler } from '../utils'

/** 恢复失败时的退避重试间隔：桌面壳冷启动/服务重启窗口内后端可能还不可达 */
const RESTORE_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000]

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
  const restoreTriggerRef = useRef<(() => void) | undefined>(undefined)
  // 只有首次恢复允许切换"恢复会话中"占位；后续后台刷新如果也置位，
  // 面板会把已挂载的 Terminal 卸载掉，连接一断一连造成状态闪烁
  const hasRestoredRef = useRef(false)

  // 同步 workspace：目录/服务端变化时重置路径并逐出事件流（状态与副作用同源）
  /* eslint-disable react-hooks/set-state-in-effect */
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
    let retryTimer: number | undefined
    const restoreSessions = async (requestId: number, attempt = 0) => {
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
        if (restoreRequestIdRef.current !== requestId) return
        // 终端 tab 不参与面板布局持久化，恢复失败 = 用户的终端在刷新后
        // 凭空消失。桌面壳冷启动/服务被重启的窗口内后端可能暂不可达：
        // 静默退避重试，终败才报错；后端转 online 时的 effect 重跑是
        // 另一层兜底。
        const delay = RESTORE_RETRY_DELAYS_MS[attempt]
        if (delay !== undefined) {
          retryTimer = window.setTimeout(() => void restoreSessions(requestId, attempt + 1), delay)
          return
        }
        uiErrorHandler('restore terminal sessions', error)
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
    restoreTriggerRef.current = () => void restoreSessions(++restoreRequestIdRef.current)
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
      restoreTriggerRef.current = undefined
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      window.removeEventListener('piui:terminals-changed', onTerminalsChanged)
      unsubscribe()
    }
  }, [normalizedDirectory])

  // 后端从 booting/offline 恢复 online 时重拉一次：桌面壳刷新后冷启动窗口
  // 内的恢复可能已失败/打到错误 workspace，online 转换是最可靠的再同步时机。
  const backendStatus = usePiBackendState().status
  const prevBackendStatusRef = useRef(backendStatus)
  useEffect(() => {
    const prev = prevBackendStatusRef.current
    prevBackendStatusRef.current = backendStatus
    if (prev !== 'online' && backendStatus === 'online') {
      restoreTriggerRef.current?.()
    }
  }, [backendStatus])

  return { isRestoring, normalizedDirectory, workspacePath }
}
