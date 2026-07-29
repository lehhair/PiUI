export type WorkspaceDto = {
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

export type WorkspaceCreateRequest = {
  /** Absolute path on host; server validates existence. */
  rootPath: string
  displayName?: string
}

export type WorkspaceCreateResponse = {
  workspace: WorkspaceDto
}

export type FileNodeDto = {
  name: string
  path: string
  type: "file" | "directory" | "symlink" | "other"
  size?: number
  mtimeMs?: number
  restricted?: boolean
}

export type FileListResponse = {
  path: string
  entries: FileNodeDto[]
  total: number
  truncated: boolean
  nextCursor?: string
}

export type FileReadResponse = {
  path: string
  content: string
  encoding: "utf-8" | "base64"
  type: "text" | "binary"
  mimeType: string
  size: number
  etag: string
}

export type FileWriteRequest = {
  content: string
  encoding?: "utf-8" | "base64"
  ifMatch?: string
}

export type FileCreateRequest = {
  path: string
  type: "file" | "directory"
  content?: string
  encoding?: "utf-8" | "base64"
  overwrite?: boolean
}

export type FileMoveRequest = {
  from: string
  to: string
  overwrite?: boolean
}

export type FileOperationResponse = {
  path: string
  type: "file" | "directory"
}

export type FileSearchStats = {
  visited: number
  scannedFiles: number
  scannedBytes: number
  durationMs: number
  truncated: boolean
  limitReason?: "results" | "entries" | "bytes" | "cancelled"
}

export type FileNameSearchResponse = {
  query: string
  paths: string[]
  stats: FileSearchStats
}

export type WorkspaceTextSearchMatch = {
  path: { text: string }
  lines: { text: string }
  line_number: number
  absolute_offset: number
  submatches: Array<{ start: number; end: number; match: { text: string } }>
}

export type FileTextSearchResponse = {
  query: string
  matches: WorkspaceTextSearchMatch[]
  stats: FileSearchStats
}
