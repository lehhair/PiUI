import { describe, expect, it } from 'vitest'
import type { GitWorkspaceMeta } from '../../../hooks'
import { getProjectGroupIdentity } from './projectGrouping'

const gitMeta: GitWorkspaceMeta = {
  isGit: true,
  rootDirectory: '/workspace/project-root',
  workspaces: ['/workspace/project-root', '/workspace/project-worktree'],
}

describe('getProjectGroupIdentity', () => {
  it('keeps a saved git subdirectory as its own project path', () => {
    expect(getProjectGroupIdentity('/workspace/project-root/subdir-a/subdir-b', gitMeta)).toEqual({
      projectId: '/workspace/project-root/subdir-a/subdir-b',
      workspaceDirectories: undefined,
    })
  })

  it('groups actual git workspace roots by git root', () => {
    expect(getProjectGroupIdentity('/workspace/project-worktree', gitMeta)).toEqual({
      projectId: '/workspace/project-root',
      workspaceDirectories: ['/workspace/project-root', '/workspace/project-worktree'],
    })
  })
})
