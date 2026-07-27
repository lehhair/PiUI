export type FileNodeType = 'file' | 'directory'
export interface FileNode { name: string; path: string; absolute: string; type: FileNodeType; ignored?: boolean }
export interface PatchHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export interface FilePatch { hunks: PatchHunk[] }
export interface FileContent {
  type: 'text' | 'binary'
  content: string
  encoding?: string
  patch?: FilePatch
  mimeType?: string
  etag?: string
  size?: number
}
export interface FileStatusItem { path: string; status: string; added?: number; removed?: number }
export interface FileDiff {
  file: string
  oldPath?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  diff?: string
  patch?: string
  status?: string
  binary?: boolean
}

export function normalizeFileDiffs(
  diffs: Array<Partial<FileDiff> & { path?: string }> | undefined,
): FileDiff[] {
  return (diffs ?? []).flatMap(diff => {
    const file = diff.file ?? diff.path
    return file ? [{ ...diff, file, additions: diff.additions ?? 0, deletions: diff.deletions ?? 0 }] : []
  })
}

export interface SymbolPosition { line: number; character: number }
export interface SymbolRange { start: SymbolPosition; end: SymbolPosition }
export interface SymbolLocation { uri?: string; path?: string; range: SymbolRange }
export interface Symbol { name: string; kind: number; location: SymbolLocation }
export interface TextSearchMatch {
  path: { text: string }
  lines: { text: string }
  line_number: number
  absolute_offset: number
  submatches: Array<{ start: number; end: number; match?: { text: string } }>
}
