/**
 * Workspace-relative path containment (Phase 1).
 * Browser only submits relative POSIX paths; absolute/drive/UNC rejected.
 */
import { realpathSync, existsSync, lstatSync, statSync } from "node:fs"
import path from "node:path"

export class PathSafetyError extends Error {
  constructor(
    readonly code: "PATH_OUTSIDE_WORKSPACE" | "SYMLINK_ESCAPE" | "INVALID_REQUEST" | "FILE_TOO_LARGE",
    message: string,
  ) {
    super(message)
    this.name = "PathSafetyError"
  }
}

const ABSOLUTE_WIN = /^[a-zA-Z]:[\\/]/
const UNC = /^[\\/]{2}/

/** Reject absolute, drive, UNC, NUL, empty. Normalize relative segments. */
export function normalizeRelativePath(input: string, platform = process.platform): string {
  if (input == null || typeof input !== "string") {
    throw new PathSafetyError("INVALID_REQUEST", "path required")
  }
  let p = input.replace(/\\/g, "/")
  if (p === "") return ""
  if (p.includes("\0")) {
    throw new PathSafetyError("INVALID_REQUEST", "NUL in path")
  }
  if (p.startsWith("/") || ABSOLUTE_WIN.test(p) || UNC.test(p)) {
    throw new PathSafetyError("PATH_OUTSIDE_WORKSPACE", "absolute path not allowed")
  }
  // strip leading ./
  while (p.startsWith("./")) p = p.slice(2)
  const parts = p.split("/").filter(seg => seg !== "" && seg !== ".")
  const out: string[] = []
  for (const seg of parts) {
    if (platform === "win32" && seg.includes(":")) {
      throw new PathSafetyError("INVALID_REQUEST", "Windows alternate data streams are not allowed")
    }
    if (seg === "..") {
      if (out.length === 0) {
        throw new PathSafetyError("PATH_OUTSIDE_WORKSPACE", "path escapes workspace via ..")
      }
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join("/")
}

function isInsideRoot(rootReal: string, targetReal: string): boolean {
  const rel = path.relative(rootReal, targetReal)
  if (rel === "") return true
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false
  return true
}

export interface ResolveResult {
  relative: string
  absolute: string
  exists: boolean
  isSymlink: boolean
  restricted: boolean
}

/**
 * Resolve workspace-relative path under root.
 * Symlinks allowed only if final realpath stays inside root.
 */
export function resolveWorkspacePath(rootPath: string, relativeInput: string): ResolveResult {
  const relative = normalizeRelativePath(relativeInput)
  const rootReal = realpathSync(rootPath)
  const joined = relative === "" ? rootReal : path.join(rootReal, ...relative.split("/"))

  if (!existsSync(joined)) {
    // for create targets: check parent containment
    const parent = path.dirname(joined)
    if (!existsSync(parent)) {
      // walk up to existing ancestor
      let cur = parent
      while (!existsSync(cur) && cur !== path.dirname(cur)) {
        cur = path.dirname(cur)
      }
      const parentReal = realpathSync(cur)
      if (!isInsideRoot(rootReal, parentReal)) {
        throw new PathSafetyError("PATH_OUTSIDE_WORKSPACE", "parent outside workspace")
      }
      const missingParent = path.relative(cur, parent)
      return {
        relative,
        absolute: path.join(path.resolve(parentReal, missingParent), path.basename(joined)),
        exists: false,
        isSymlink: false,
        restricted: false,
      }
    } else {
      const parentReal = realpathSync(parent)
      if (!isInsideRoot(rootReal, parentReal)) {
        throw new PathSafetyError("PATH_OUTSIDE_WORKSPACE", "parent outside workspace")
      }
      return {
        relative,
        absolute: path.join(parentReal, path.basename(joined)),
        exists: false,
        isSymlink: false,
        restricted: false,
      }
    }
  }

  let isSymlink = false
  try {
    isSymlink = lstatSync(joined).isSymbolicLink()
  } catch {
    isSymlink = false
  }

  const targetReal = realpathSync(joined)
  if (!isInsideRoot(rootReal, targetReal)) {
    if (isSymlink) {
      throw new PathSafetyError("SYMLINK_ESCAPE", "symlink points outside workspace")
    }
    throw new PathSafetyError("PATH_OUTSIDE_WORKSPACE", "resolved path outside workspace")
  }

  // ensure we can stat
  statSync(targetReal)

  return {
    relative,
    absolute: targetReal,
    exists: true,
    isSymlink,
    restricted: false,
  }
}
