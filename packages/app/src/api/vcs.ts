// ============================================
// VCS API - 版本控制信息（Pi server first）
// ============================================

import { getSDKClient, unwrap } from './sdk'
import type { FileDiff } from './types'
import type { VcsDiffMode, VcsInfo } from '../types/api/vcs'
import { formatPathForApi } from '../utils/directoryUtils'
import { normalizeFileDiffs } from '../types/api/file'
import { isPiServerUp, resolveWorkspaceId } from '../pi/sessionApi'

/**
 * 获取 VCS 信息
 */
export async function getVcsInfo(directory?: string): Promise<VcsInfo | null> {
  try {
    if (await isPiServerUp()) {
      const workspaceId = await resolveWorkspaceId(directory)
      if (!workspaceId) return null
      const { getWorkspaceGitInfo } = await import('../pi/sessionApi')
      const info = await getWorkspaceGitInfo(workspaceId)
      if (!info.root) return null
      return {
        branch: info.branch,
        // loose shape for OCUI consumers
      } as VcsInfo
    }
    const sdk = getSDKClient()
    return unwrap(await sdk.vcs.get({ directory: formatPathForApi(directory) }))
  } catch {
    // VCS 不可用时返回 null
    return null
  }
}

/**
 * 获取 Git 或分支维度的 diff
 */
export async function getVcsDiff(mode: VcsDiffMode, directory?: string): Promise<FileDiff[]> {
  if (await isPiServerUp()) {
    const workspaceId = await resolveWorkspaceId(directory)
    if (!workspaceId) return []
    try {
      const { getWorkspaceGitDiff } = await import('../pi/sessionApi')
      const m = mode === 'branch' ? 'branch' : 'git'
      const diff = await getWorkspaceGitDiff(workspaceId, m)
      return diff.files.map(f => ({
        file: f.file,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })) as FileDiff[]
    } catch {
      return []
    }
  }
  const sdk = getSDKClient()
  return normalizeFileDiffs(unwrap(await sdk.vcs.diff({ mode, directory: formatPathForApi(directory) })))
}
