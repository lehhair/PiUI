export interface GitStatusItemV1 {
  path: string
  status: "added" | "modified" | "deleted" | "unknown"
  added?: number
  removed?: number
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
  ahead: number
  behind: number
}

export interface GitDiffItemV1 {
  file: string
  status: "added" | "modified" | "deleted"
  additions: number
  deletions: number
}

export interface GitDiffResponseV1 {
  mode: "git" | "branch"
  files: GitDiffItemV1[]
}
