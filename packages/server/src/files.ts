import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { FileListResponseV1, FileNodeDtoV1, FileReadResponseV1 } from "@piui/protocol"
import { PathSafetyError, resolveWorkspacePath } from "./path-safety.ts"
import type { WorkspaceRecord } from "./workspace-store.ts"

const MAX_TEXT_PREVIEW = 2 * 1024 * 1024
const MAX_DIR_ENTRIES = 5000

export function listFiles(ws: WorkspaceRecord, relativePath: string): FileListResponseV1 {
  const resolved = resolveWorkspacePath(ws.canonicalRoot, relativePath)
  if (!resolved.exists) {
    throw new PathSafetyError("INVALID_REQUEST", "path does not exist")
  }
  const st = statSync(resolved.absolute)
  if (!st.isDirectory()) {
    throw new PathSafetyError("INVALID_REQUEST", "not a directory")
  }
  const names = readdirSync(resolved.absolute)
  const entries: FileNodeDtoV1[] = []
  for (const name of names) {
    if (entries.length >= MAX_DIR_ENTRIES) break
    const childRel =
      resolved.relative === "" ? name : `${resolved.relative}/${name}`.replace(/\\/g, "/")
    try {
      const child = resolveWorkspacePath(ws.canonicalRoot, childRel)
      const cst = statSync(child.absolute)
      let type: FileNodeDtoV1["type"] = "other"
      if (cst.isDirectory()) type = "directory"
      else if (cst.isFile()) type = "file"
      if (child.isSymlink) type = "symlink"
      entries.push({
        name,
        path: child.relative,
        type,
        size: cst.isFile() ? cst.size : undefined,
        mtimeMs: cst.mtimeMs,
        restricted: child.restricted,
      })
    } catch (e) {
      if (e instanceof PathSafetyError && e.code === "SYMLINK_ESCAPE") {
        entries.push({
          name,
          path: childRel,
          type: "symlink",
          restricted: true,
        })
        continue
      }
      throw e
    }
  }
  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1
    if (a.type !== "directory" && b.type === "directory") return 1
    return a.name.localeCompare(b.name)
  })
  return { path: resolved.relative, entries }
}

export function readFileText(ws: WorkspaceRecord, relativePath: string): FileReadResponseV1 {
  const resolved = resolveWorkspacePath(ws.canonicalRoot, relativePath)
  if (!resolved.exists) {
    throw new PathSafetyError("INVALID_REQUEST", "path does not exist")
  }
  if (resolved.restricted) {
    throw new PathSafetyError("SYMLINK_ESCAPE", "restricted path")
  }
  const st = statSync(resolved.absolute)
  if (!st.isFile()) {
    throw new PathSafetyError("INVALID_REQUEST", "not a file")
  }
  if (st.size > MAX_TEXT_PREVIEW) {
    const err = new PathSafetyError("INVALID_REQUEST", "file too large for preview")
    ;(err as PathSafetyError & { code: string }).code = "FILE_TOO_LARGE"
    throw Object.assign(new Error("file too large for preview"), { code: "FILE_TOO_LARGE" as const })
  }
  const buf = readFileSync(resolved.absolute)
  const content = buf.toString("utf8")
  const etag = createHash("sha256").update(buf).digest("hex").slice(0, 16)
  return {
    path: resolved.relative,
    content,
    encoding: "utf-8",
    size: buf.length,
    etag,
  }
}

// silence unused path import when only used in types on some platforms
void path
