// ============================================
// VCS API - Pi-native workspace version control
// ============================================

import type { FileDiff } from './types'
import type { VcsDiffMode, VcsInfo } from '../types/api/vcs'
import {
  getWorkspaceGitDiff,
  getWorkspaceGitFileDiff,
  getWorkspaceGitInfo,
  resolveWorkspacePath,
} from '../pi/sessionApi'
import type { GitDiffModeV1 } from '@piui/protocol'

/**
 * 获取 VCS 信息
 */
export async function getVcsInfo(directory?: string, signal?: AbortSignal): Promise<VcsInfo | null> {
  const workspacePath = await resolveWorkspacePath(directory)
  if (!workspacePath) return null
  const info = signal
    ? await getWorkspaceGitInfo(workspacePath, signal)
    : await getWorkspaceGitInfo(workspacePath)
  if (!info.root) return null
  return {
    branch: info.branch ?? undefined,
    default_branch: info.defaultBranch,
    root: info.rootPath,
    upstream: info.upstream,
    ahead: info.ahead,
    behind: info.behind,
  }
}

/**
 * 获取 Git 或分支维度的 diff
 */
export async function getVcsDiff(mode: VcsDiffMode, directory?: string, signal?: AbortSignal): Promise<FileDiff[]> {
  const workspacePath = await resolveWorkspacePath(directory)
  if (!workspacePath) return []
  const diff = signal
    ? await getWorkspaceGitDiff(workspacePath, toGitMode(mode), signal)
    : await getWorkspaceGitDiff(workspacePath, toGitMode(mode))
  return diff.files.map(file => {
    const mapped: FileDiff = {
      file: file.file,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }
    if (file.oldPath !== undefined) mapped.oldPath = file.oldPath
    if (file.binary !== undefined) mapped.binary = file.binary
    return mapped
  })
}

export async function getVcsFileDiff(
  mode: VcsDiffMode,
  file: string,
  directory?: string,
  signal?: AbortSignal,
): Promise<FileDiff> {
  const workspacePath = await resolveWorkspacePath(directory)
  if (!workspacePath) throw new Error('No PiUI workspace is available')
  const diff = await getWorkspaceGitFileDiff(workspacePath, toGitMode(mode), file, signal)
  return {
    file: diff.file,
    oldPath: diff.oldPath,
    status: diff.status,
    additions: diff.additions,
    deletions: diff.deletions,
    binary: diff.binary,
    patch: diff.patch,
  }
}

function toGitMode(mode: VcsDiffMode): GitDiffModeV1 {
  if (mode === 'branch' || mode === 'staged' || mode === 'unstaged') return mode
  return 'git'
}
