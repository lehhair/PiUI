import { useState, useCallback } from 'react'
import type { ToolType, PermissionDecision } from '../types'

interface UsePermissionsReturn {
  // 会话级别已授权的工具
  sessionApprovedTools: Set<ToolType>
  // 检查工具是否需要请求权限
  needsApproval: (tool: ToolType) => boolean
  // 记录权限决定
  recordDecision: (tool: ToolType, decision: PermissionDecision) => void
  // 重置所有权限
  resetPermissions: () => void
}

/**
 * Hook for managing tool permissions in the chat session
 */
export function usePermissions(): UsePermissionsReturn {
  const [sessionApprovedTools, setSessionApprovedTools] = useState<Set<ToolType>>(new Set())

  const needsApproval = useCallback(
    (tool: ToolType): boolean => {
      // 如果已经在会话中批准过，则不需要再次批准
      if (sessionApprovedTools.has(tool)) {
        return false
      }
      return true
    },
    [sessionApprovedTools],
  )

  const recordDecision = useCallback((tool: ToolType, decision: PermissionDecision) => {
    if (decision === 'approved_session') {
      setSessionApprovedTools(prev => new Set([...prev, tool]))
    }
    // approved_once 不需要记录，每次都会询问
    // rejected 也不需要记录
  }, [])

  const resetPermissions = useCallback(() => {
    setSessionApprovedTools(new Set())
  }, [])

  return {
    sessionApprovedTools,
    needsApproval,
    recordDecision,
    resetPermissions,
  }
}
