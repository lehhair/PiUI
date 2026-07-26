export interface WorkspaceDtoV1 {
  /**
   * Canonical absolute path, which is also the identity: a workspace is a
   * directory, so there is nothing else to identify it by. Clients send this
   * back URL-encoded wherever a workspace is addressed.
   */
  path: string
  displayName: string
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
