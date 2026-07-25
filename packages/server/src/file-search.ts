import { readdirSync, readFileSync, statSync } from "node:fs"
import { resolveWorkspacePath, PathSafetyError } from "./path-safety.ts"
import type { WorkspaceRecord } from "./workspace-store.ts"

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".turbo",
  "target",
])

const MAX_RESULTS = 200
const MAX_VISIT = 20_000
const MAX_TEXT_FILE_BYTES = 1024 * 1024
const MAX_TEXT_TOTAL_BYTES = 20 * 1024 * 1024

export interface WorkspaceTextSearchMatch {
  path: { text: string }
  lines: { text: string }
  line_number: number
  absolute_offset: number
  submatches: Array<{ start: number; end: number; match: { text: string } }>
}

export function searchFilesByName(
  ws: WorkspaceRecord,
  query: string,
  opts?: { type?: "file" | "directory"; limit?: number },
): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const limit = Math.min(opts?.limit ?? 50, MAX_RESULTS)
  const results: string[] = []
  let visited = 0

  const root = resolveWorkspacePath(ws.canonicalRoot, "")
  if (!root.exists) return []

  const stack: string[] = [""]
  while (stack.length > 0 && results.length < limit && visited < MAX_VISIT) {
    const rel = stack.pop()!
    let abs: string
    try {
      const r = resolveWorkspacePath(ws.canonicalRoot, rel)
      if (!r.exists || r.restricted) continue
      abs = r.absolute
    } catch {
      continue
    }

    let entries: string[]
    try {
      entries = readdirSync(abs)
    } catch {
      continue
    }

    for (const name of entries) {
      if (results.length >= limit || visited >= MAX_VISIT) break
      visited++
      if (name === "." || name === "..") continue
      const childRel = rel ? `${rel}/${name}` : name
      let st
      try {
        const child = resolveWorkspacePath(ws.canonicalRoot, childRel)
        if (!child.exists || child.restricted) continue
        st = statSync(child.absolute)
      } catch (e) {
        if (e instanceof PathSafetyError) continue
        continue
      }

      const isDir = st.isDirectory()
      if (isDir && SKIP_DIRS.has(name)) continue

      const match = name.toLowerCase().includes(q) || childRel.toLowerCase().includes(q)
      if (match) {
        if (!opts?.type || (opts.type === "directory" && isDir) || (opts.type === "file" && !isDir)) {
          results.push(childRel.replace(/\\/g, "/"))
        }
      }
      if (isDir) stack.push(childRel)
    }
  }

  return results
}

export function searchWorkspaceText(
  ws: WorkspaceRecord,
  pattern: string,
  opts?: { limit?: number },
): WorkspaceTextSearchMatch[] {
  const needle = pattern.trim()
  if (!needle) return []

  const normalizedNeedle = needle.toLowerCase()
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), MAX_RESULTS)
  const results: WorkspaceTextSearchMatch[] = []
  let visited = 0
  let totalBytes = 0

  const root = resolveWorkspacePath(ws.canonicalRoot, "")
  if (!root.exists) return []

  const stack: string[] = [""]
  while (
    stack.length > 0 &&
    results.length < limit &&
    visited < MAX_VISIT &&
    totalBytes < MAX_TEXT_TOTAL_BYTES
  ) {
    const rel = stack.pop()!
    let entries: string[]
    try {
      const resolved = resolveWorkspacePath(ws.canonicalRoot, rel)
      if (!resolved.exists || resolved.restricted) continue
      entries = readdirSync(resolved.absolute)
    } catch {
      continue
    }

    for (const name of entries) {
      if (results.length >= limit || visited >= MAX_VISIT || totalBytes >= MAX_TEXT_TOTAL_BYTES) break
      visited++
      if (name === "." || name === "..") continue

      const childRel = rel ? `${rel}/${name}` : name
      let absolute: string
      let stat
      try {
        const child = resolveWorkspacePath(ws.canonicalRoot, childRel)
        if (!child.exists || child.restricted) continue
        absolute = child.absolute
        stat = statSync(absolute)
      } catch (error) {
        if (error instanceof PathSafetyError) continue
        continue
      }

      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(childRel)
        continue
      }
      if (!stat.isFile() || stat.size > MAX_TEXT_FILE_BYTES) continue
      if (totalBytes + stat.size > MAX_TEXT_TOTAL_BYTES) continue
      totalBytes += stat.size

      let buffer: Buffer
      try {
        buffer = readFileSync(absolute)
      } catch {
        continue
      }
      if (buffer.includes(0)) continue

      const content = buffer.toString("utf8")
      const lines = content.split(/\r?\n/)
      let absoluteOffset = 0
      for (let lineIndex = 0; lineIndex < lines.length && results.length < limit; lineIndex++) {
        const line = lines[lineIndex]
        const normalizedLine = line.toLowerCase()
        const submatches: WorkspaceTextSearchMatch["submatches"] = []
        let start = normalizedLine.indexOf(normalizedNeedle)
        while (start >= 0) {
          const end = start + needle.length
          submatches.push({
            start: Buffer.byteLength(line.slice(0, start), "utf8"),
            end: Buffer.byteLength(line.slice(0, end), "utf8"),
            match: { text: line.slice(start, end) },
          })
          start = normalizedLine.indexOf(normalizedNeedle, end)
        }
        if (submatches.length > 0) {
          results.push({
            path: { text: childRel.replace(/\\/g, "/") },
            lines: { text: line },
            line_number: lineIndex + 1,
            absolute_offset: absoluteOffset,
            submatches,
          })
        }
        absoluteOffset += Buffer.byteLength(line, "utf8") + 1
      }
    }
  }

  return results
}
