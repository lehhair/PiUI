import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import type {
  FileNameSearchResponse,
  FileSearchStats,
  FileTextSearchResponse,
  WorkspaceTextSearchMatch,
} from "@piui/protocol"
import type { WorkspaceRecord } from "./workspace-store.ts"
import { resolveWorkspacePath } from "./path-safety.ts"

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__", ".turbo", "target",
])
const MAX_RESULTS = 200
const MAX_VISIT = 50_000
const MAX_TEXT_FILE_BYTES = 1024 * 1024
const MAX_TEXT_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_QUERY_BYTES = 64 * 1024

export async function searchFilesByName(
  ws: WorkspaceRecord,
  query: string,
  opts: { type?: "file" | "directory"; limit?: number; signal?: AbortSignal } = {},
): Promise<FileNameSearchResponse> {
  const started = performance.now()
  const needle = query.trim().toLocaleLowerCase()
  assertQuerySize(needle)
  const limit = boundedLimit(opts.limit)
  const paths: string[] = []
  let visited = 0
  let scannedFiles = 0
  let limitReason: FileSearchStats["limitReason"]
  if (needle) {
    await walkWorkspace(ws, opts.signal, async entry => {
      visited++
      if (!entry.isDirectory) scannedFiles++
      if (entry.relative.toLocaleLowerCase().includes(needle) &&
        (!opts.type || (opts.type === "directory") === entry.isDirectory)) {
        paths.push(entry.relative)
      }
      if (paths.length >= limit) {
        limitReason = "results"
        return false
      }
      if (visited >= MAX_VISIT) {
        limitReason = "entries"
        return false
      }
      return true
    })
  }
  return {
    query,
    paths,
    stats: stats(started, visited, scannedFiles, 0, limitReason),
  }
}

export async function searchWorkspaceText(
  ws: WorkspaceRecord,
  pattern: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<FileTextSearchResponse> {
  const started = performance.now()
  const needle = pattern.trim()
  assertQuerySize(needle)
  const limit = boundedLimit(opts.limit)
  const matcher = needle ? new RegExp(escapeRegExp(needle), "giu") : undefined
  const matches: WorkspaceTextSearchMatch[] = []
  let visited = 0
  let scannedFiles = 0
  let scannedBytes = 0
  let limitReason: FileSearchStats["limitReason"]
  if (needle) {
    await walkWorkspace(ws, opts.signal, async entry => {
      visited++
      if (entry.isDirectory) {
        if (visited >= MAX_VISIT) {
          limitReason = "entries"
          return false
        }
        return true
      }
      if (visited >= MAX_VISIT) {
        limitReason = "entries"
        return false
      }
      let fileStat
      let safeAbsolute: string
      try {
        const resolved = resolveWorkspacePath(ws.canonicalRoot, entry.relative)
        safeAbsolute = resolved.absolute
        fileStat = await stat(safeAbsolute)
      } catch {
        return true
      }
      if (!fileStat.isFile() || fileStat.size > MAX_TEXT_FILE_BYTES) return true
      if (scannedBytes + fileStat.size > MAX_TEXT_TOTAL_BYTES) {
        limitReason = "bytes"
        return false
      }
      let buffer: Buffer
      try {
        buffer = await readFile(safeAbsolute)
      } catch {
        return true
      }
      if (buffer.length > MAX_TEXT_FILE_BYTES || scannedBytes + buffer.length > MAX_TEXT_TOTAL_BYTES) {
        limitReason = "bytes"
        return false
      }
      try {
        const verified = resolveWorkspacePath(ws.canonicalRoot, entry.relative)
        if (verified.absolute !== safeAbsolute) return true
      } catch {
        return true
      }
      if (buffer.includes(0)) return true
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(buffer)
      } catch {
        return true
      }
      scannedFiles++
      scannedBytes += buffer.length
       collectTextMatches(buffer.toString("utf8"), entry.relative, matcher!, matches, limit)
      if (matches.length >= limit) {
        limitReason = "results"
        return false
      }
      return true
    })
  }
  return {
    query: pattern,
    matches,
    stats: stats(started, visited, scannedFiles, scannedBytes, limitReason),
  }
}

interface WalkEntry {
  relative: string
  absolute: string
  isDirectory: boolean
}

async function walkWorkspace(
  ws: WorkspaceRecord,
  signal: AbortSignal | undefined,
  visit: (entry: WalkEntry) => boolean | Promise<boolean>,
): Promise<void> {
  const directories = [""]
  while (directories.length > 0) {
    throwIfAborted(signal)
    const relativeDirectory = directories.pop()!
    let absoluteDirectory: string
    try {
      absoluteDirectory = resolveWorkspacePath(ws.canonicalRoot, relativeDirectory).absolute
    } catch {
      continue
    }
    let entries
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const childDirectories: string[] = []
    for (const entry of entries) {
      throwIfAborted(signal)
      if (entry.isSymbolicLink()) continue
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const isDirectory = entry.isDirectory()
      if (isDirectory && SKIP_DIRS.has(entry.name)) continue
      if (!await visit({
        relative,
        absolute: path.join(absoluteDirectory, entry.name),
        isDirectory,
      })) return
      if (isDirectory) childDirectories.push(relative)
    }
    for (let index = childDirectories.length - 1; index >= 0; index--) directories.push(childDirectories[index]!)
  }
}

function collectTextMatches(
  content: string,
  relativePath: string,
  matcher: RegExp,
  results: WorkspaceTextSearchMatch[],
  limit: number,
): void {
  let charOffset = 0
  let byteOffset = 0
  let lineNumber = 1
  while (charOffset <= content.length && results.length < limit) {
    const newline = content.indexOf("\n", charOffset)
    const end = newline < 0 ? content.length : newline
    const rawLine = content.slice(charOffset, end)
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    const submatches: WorkspaceTextSearchMatch["submatches"] = []
    matcher.lastIndex = 0
    for (const match of line.matchAll(matcher)) {
      const start = match.index
      const matchEnd = start + match[0].length
      submatches.push({
        start: Buffer.byteLength(line.slice(0, start), "utf8"),
        end: Buffer.byteLength(line.slice(0, matchEnd), "utf8"),
        match: { text: match[0] },
      })
    }
    if (submatches.length > 0) {
      results.push({
        path: { text: relativePath },
        lines: { text: line },
        line_number: lineNumber,
        absolute_offset: byteOffset,
        submatches,
      })
    }
    if (newline < 0) break
    const consumed = content.slice(charOffset, newline + 1)
    byteOffset += Buffer.byteLength(consumed, "utf8")
    charOffset = newline + 1
    lineNumber++
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function assertQuerySize(query: string): void {
  if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
    throw Object.assign(new Error(`query must be at most ${MAX_QUERY_BYTES} bytes`), { code: "INVALID_REQUEST" })
  }
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw Object.assign(new Error(`limit must be an integer between 1 and ${MAX_RESULTS}`), { code: "INVALID_REQUEST" })
  }
  return limit
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw Object.assign(new Error("search cancelled"), { code: "REQUEST_ABORTED" })
}

function stats(
  started: number,
  visited: number,
  scannedFiles: number,
  scannedBytes: number,
  limitReason: FileSearchStats["limitReason"],
): FileSearchStats {
  return {
    visited,
    scannedFiles,
    scannedBytes,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    truncated: limitReason !== undefined,
    limitReason,
  }
}
