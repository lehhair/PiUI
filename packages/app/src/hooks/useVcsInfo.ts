// ============================================
// useVcsInfo - VCS 信息 Hook
// 轮询获取当前项目的 Git 分支信息
// ============================================

import { useState, useEffect, useCallback, useRef } from 'react'
import type { GitInfoResponse } from '@piui/protocol'
import { getHostGitInfo } from '../pi/transport/index.js'
import { resolveWorkspacePath } from '../pi/workspaces'

const POLL_INTERVAL = 15000 // 15s 轮询

export interface UseVcsInfoResult {
  vcsInfo: GitInfoResponse | null
  isLoading: boolean
  error: string | null
  refresh: () => void
}

export function useVcsInfo(directory?: string): UseVcsInfoResult {
  const [vcsInfo, setVcsInfo] = useState<GitInfoResponse | null>(null)
  const [isLoading, setIsLoading] = useState(Boolean(directory))
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const requestIdRef = useRef(0)

  const fetchVcs = useCallback(async () => {
    const requestId = ++requestIdRef.current

    if (!directory) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setVcsInfo(null)
        setError(null)
        setIsLoading(false)
      }
      return
    }

    setIsLoading(true)
    try {
      const workspacePath = await resolveWorkspacePath(directory)
      const info = workspacePath ? await getHostGitInfo(workspacePath) : null
      if (mountedRef.current && requestId === requestIdRef.current) {
        setVcsInfo(info)
        setError(null)
      }
    } catch (e) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setError(e instanceof Error ? e.message : 'Failed to fetch VCS info')
        setVcsInfo(null)
      }
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setIsLoading(false)
      }
    }
  }, [directory])

  // 初始加载 + 目录变化时重新获取：请求-响应模式，重置/loading 与请求同步设置
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    mountedRef.current = true
    setVcsInfo(null)
    setError(null)
    setIsLoading(Boolean(directory))
    void fetchVcs()
    return () => {
      mountedRef.current = false
    }
  }, [directory, fetchVcs])

  // 轮询
  useEffect(() => {
    if (!directory) return

    const timer = setInterval(fetchVcs, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [directory, fetchVcs])

  return { vcsInfo, isLoading, error, refresh: fetchVcs }
}
