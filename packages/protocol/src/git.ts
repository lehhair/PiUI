export type GitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "conflicted"
  | "untracked"
  | "unknown"

export type GitStatusItem = {
  path: string
  oldPath?: string
  status: GitFileStatus
  indexStatus: string
  worktreeStatus: string
  staged: boolean
  unstaged: boolean
}

export type GitStatusResponse = {
  branch: string | null
  ahead: number
  behind: number
  items: GitStatusItem[]
}

export type GitInfoResponse = {
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

export type GitDiffMode = "git" | "branch" | "staged" | "unstaged"

export type GitDiffItem = {
  file: string
  oldPath?: string
  status: Exclude<GitFileStatus, "conflicted" | "unknown">
  additions: number
  deletions: number
  binary: boolean
}

export type GitDiffResponse = {
  mode: GitDiffMode
  baseRef?: string
  baseCommit?: string
  files: GitDiffItem[]
}

export type GitFileDiffResponse = GitDiffItem & {
  mode: GitDiffMode
  patch: string
  truncated: boolean
}
