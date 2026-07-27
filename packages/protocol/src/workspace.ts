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
  total: number
  truncated: boolean
  nextCursor?: string
}

export interface FileReadResponseV1 {
  path: string
  content: string
  encoding: "utf-8" | "base64"
  type: "text" | "binary"
  mimeType: string
  size: number
  etag: string
}

export interface FileWriteRequestV1 {
  content: string
  encoding?: "utf-8" | "base64"
  ifMatch?: string
}

export interface FileCreateRequestV1 {
  path: string
  type: "file" | "directory"
  content?: string
  encoding?: "utf-8" | "base64"
  overwrite?: boolean
}

export interface FileMoveRequestV1 {
  from: string
  to: string
  overwrite?: boolean
}

export interface FileOperationResponseV1 {
  path: string
  type: "file" | "directory"
}

export interface FileSearchStatsV1 {
  visited: number
  scannedFiles: number
  scannedBytes: number
  durationMs: number
  truncated: boolean
  limitReason?: "results" | "entries" | "bytes" | "cancelled"
}

export interface FileNameSearchResponseV1 {
  query: string
  paths: string[]
  stats: FileSearchStatsV1
}

export interface WorkspaceTextSearchMatchV1 {
  path: { text: string }
  lines: { text: string }
  line_number: number
  absolute_offset: number
  submatches: Array<{ start: number; end: number; match: { text: string } }>
}

export interface FileTextSearchResponseV1 {
  query: string
  matches: WorkspaceTextSearchMatchV1[]
  stats: FileSearchStatsV1
}
