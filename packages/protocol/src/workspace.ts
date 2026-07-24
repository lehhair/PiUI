export interface WorkspaceDtoV1 {
  id: string
  displayName: string
  /** Browser never sees absolute root; server-only. Present only in server memory. */
  createdAt: string
  lastOpenedAt: string
}

export interface WorkspaceCreateRequestV1 {
  /** Absolute path on host; server validates existence. */
  rootPath: string
  displayName?: string
}

export interface WorkspaceCreateResponseV1 {
  workspace: WorkspaceDtoV1
}

export interface FileNodeDtoV1 {
  name: string
  path: string
  type: "file" | "directory" | "symlink" | "other"
  size?: number
  mtimeMs?: number
  restricted?: boolean
}

export interface FileListResponseV1 {
  path: string
  entries: FileNodeDtoV1[]
}

export interface FileReadResponseV1 {
  path: string
  content: string
  encoding: "utf-8"
  size: number
  etag: string
}
