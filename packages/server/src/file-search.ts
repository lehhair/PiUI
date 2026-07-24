import { readdirSync, statSync } from "node:fs"
import path from "node:path"
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

// keep path import used
void path
