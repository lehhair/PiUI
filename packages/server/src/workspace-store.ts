import { existsSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import type { WorkspaceDtoV1 } from "@piui/protocol"

export interface WorkspaceRecord {
  displayName: string
  canonicalRoot: string
  createdAt: string
  lastOpenedAt: string
}

/**
 * A workspace is just a directory. Pi identifies a session by its `cwd`, so the
 * canonical path is the identity here too; the store only validates paths and
 * remembers presentation metadata for the ones seen so far.
 */
export class WorkspaceStore {
  private readonly byPath = new Map<string, WorkspaceRecord>()

  list(): WorkspaceDtoV1[] {
    return [...this.byPath.values()].map(toDto)
  }

  /** Looks up an already-known workspace without touching the filesystem. */
  find(rootPath: string): WorkspaceRecord | undefined {
    return this.byPath.get(workspacePathKey(path.resolve(rootPath)))
  }

  /**
   * Validates the path, resolves it through symlinks, and records it. Callers
   * pass whatever path they were given, so this is the single place that decides
   * what "the same workspace" means.
   */
  resolve(rootPath: string, displayName?: string): WorkspaceRecord {
    const resolved = path.resolve(rootPath)
    if (!existsSync(resolved)) {
      throw Object.assign(new Error(`workspace root not found: ${resolved}`), {
        code: "WORKSPACE_NOT_FOUND" as const,
      })
    }
    const st = statSync(resolved)
    if (!st.isDirectory()) {
      throw Object.assign(new Error("workspace root must be a directory"), {
        code: "INVALID_REQUEST" as const,
      })
    }
    const abs = realpathSync.native(resolved)
    const key = workspacePathKey(abs)
    const existing = this.byPath.get(key)
    if (existing) {
      existing.lastOpenedAt = new Date().toISOString()
      if (displayName?.trim()) existing.displayName = displayName.trim()
      return existing
    }
    const now = new Date().toISOString()
    const rec: WorkspaceRecord = {
      displayName: displayName?.trim() || path.basename(abs) || abs,
      canonicalRoot: abs,
      createdAt: now,
      lastOpenedAt: now,
    }
    this.byPath.set(key, rec)
    return rec
  }
}

/** Two paths name one workspace when their keys match. */
export function workspacePathKey(rootPath: string, platform = process.platform): string {
  return platform === "win32" ? rootPath.toLowerCase() : rootPath
}

function toDto(r: WorkspaceRecord): WorkspaceDtoV1 {
  return {
    path: r.canonicalRoot,
    displayName: r.displayName,
    createdAt: r.createdAt,
    lastOpenedAt: r.lastOpenedAt,
  }
}
