export type GitFileStatusV1 =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "conflicted"
  | "untracked"
  | "unknown"

export interface GitStatusItemV1 {
  path: string
  oldPath?: string
  status: GitFileStatusV1
  indexStatus: string
  worktreeStatus: string
  staged: boolean
  unstaged: boolean
}

export interface GitStatusResponseV1 {
  branch: string | null
  ahead: number
  behind: number
  items: GitStatusItemV1[]
}

export interface GitInfoResponseV1 {
  branch: string | null
  root: boolean
  rootPath?: string
  headOid?: string
  detached: boolean
  unborn: boolean
  upstream?: string
  defaultBranch?: string
  ahead: number
  behind: number
}

export type GitDiffModeV1 = "git" | "branch" | "staged" | "unstaged"

export interface GitDiffItemV1 {
  file: string
  oldPath?: string
  status: Exclude<GitFileStatusV1, "conflicted" | "unknown">
  additions: number
  deletions: number
  binary: boolean
}

export interface GitDiffResponseV1 {
  mode: GitDiffModeV1
  baseRef?: string
  baseCommit?: string
  files: GitDiffItemV1[]
}

export interface GitFileDiffResponseV1 extends GitDiffItemV1 {
  mode: GitDiffModeV1
  patch: string
  truncated: boolean
}
