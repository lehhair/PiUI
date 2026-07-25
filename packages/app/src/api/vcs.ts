// ============================================
// VCS API - Pi-native workspace version control
// ============================================

import type { FileDiff } from './types'
import type { VcsDiffMode, VcsInfo } from '../types/api/vcs'
import { getWorkspaceGitDiff, getWorkspaceGitInfo, resolveWorkspaceId } from '../pi/sessionApi'

/**
 * 获取 VCS 信息
 */
export async function getVcsInfo(directory?: string): Promise<VcsInfo | null> {
  try {
    const workspaceId = await resolveWorkspaceId(directory)
    if (!workspaceId) return null
    const info = await getWorkspaceGitInfo(workspaceId)
    if (!info.root) return null
    return {
      branch: info.branch ?? undefined,
      ahead: info.ahead,
      behind: info.behind,
    }
  } catch {
    // VCS 不可用时返回 null
    return null
  }
}

/**
 * 获取 Git 或分支维度的 diff
 */
export async function getVcsDiff(mode: VcsDiffMode, directory?: string): Promise<FileDiff[]> {
  try {
    const workspaceId = await resolveWorkspaceId(directory)
    if (!workspaceId) return []
    const diff = await getWorkspaceGitDiff(workspaceId, mode === 'branch' ? 'branch' : 'git')
    return diff.files.map(file => ({
      file: file.file,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }))
  } catch {
    return []
  }
}
