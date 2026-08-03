import { existsSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import type { WorkspaceDto } from "@piui/protocol"

export interface WorkspaceRecord {
  displayName: string
  canonicalRoot: string
  rootIdentity?: string
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
  private readonly byInputPath = new Map<string, WorkspaceRecord>()
  private readonly closed = new Set<string>()

  list(): WorkspaceDto[] {
    return [...this.byPath.values()].map(toDto)
  }

  /** Looks up an already-known workspace without touching the filesystem. */
  find(rootPath: string): WorkspaceRecord | undefined {
    const key = workspacePathKey(path.resolve(rootPath))
    return this.byInputPath.get(key) ?? this.byPath.get(key)
  }

  /** A closed workspace must be explicitly opened again before host commands use it. */
  isClosed(rootPath: string): boolean {
    const key = workspacePathKey(path.resolve(rootPath))
    return this.closed.has(key)
  }

  /** Revalidates a known workspace before an operation uses its root. */
  assertCurrent(record: WorkspaceRecord): void {
    if (record.rootIdentity === undefined) return
    try {
      const resolved = path.resolve(record.canonicalRoot)
      const real = realpathSync.native(resolved)
      const identity = fileIdentity(statSync(real))
      if (workspacePathKey(real) !== workspacePathKey(record.canonicalRoot) || identity !== record.rootIdentity) {
        throw workspaceReplaced(record.canonicalRoot)
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "WORKSPACE_REPLACED") throw error
      throw workspaceReplaced(record.canonicalRoot)
    }
  }

  /**
   * Validates the path, resolves it through symlinks, and records it. Callers
   * pass whatever path they were given, so this is the single place that decides
   * what "the same workspace" means.
   */
  resolve(rootPath: string, displayName?: string): WorkspaceRecord {
    const resolved = path.resolve(rootPath)
    const inputKey = workspacePathKey(resolved)
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
    const rootIdentity = fileIdentity(statSync(abs))
    const key = workspacePathKey(abs)
    this.closed.delete(inputKey)
    this.closed.delete(key)
    const prior = this.byInputPath.get(inputKey)
    if (prior && (workspacePathKey(prior.canonicalRoot) !== key ||
      prior.rootIdentity !== undefined && prior.rootIdentity !== rootIdentity)) {
      throw workspaceReplaced(resolved)
    }
    if (prior) {
      prior.lastOpenedAt = new Date().toISOString()
      if (displayName?.trim()) prior.displayName = displayName.trim()
      return prior
    }
    const existing = this.byPath.get(key)
    if (existing) {
      if (existing.rootIdentity !== undefined && existing.rootIdentity !== rootIdentity) {
        throw workspaceReplaced(resolved)
      }
      existing.lastOpenedAt = new Date().toISOString()
      if (displayName?.trim()) existing.displayName = displayName.trim()
      this.byInputPath.set(inputKey, existing)
      return existing
    }
    const now = new Date().toISOString()
    const rec: WorkspaceRecord = {
      displayName: displayName?.trim() || path.basename(abs) || abs,
      canonicalRoot: abs,
      rootIdentity,
      createdAt: now,
      lastOpenedAt: now,
    }
    this.byPath.set(key, rec)
    this.byInputPath.set(inputKey, rec)
    this.byInputPath.set(key, rec)
    return rec
  }

  remove(rootPath: string): boolean {
    const inputKey = workspacePathKey(path.resolve(rootPath))
    const key = inputKey
    const record = this.byInputPath.get(key) ?? this.byPath.get(key)
    if (!record) return false
    this.closed.add(inputKey)
    this.closed.add(workspacePathKey(record.canonicalRoot))
    this.byPath.delete(workspacePathKey(record.canonicalRoot))
    for (const [input, value] of this.byInputPath) {
      if (value === record) this.byInputPath.delete(input)
    }
    return true
  }
}

function fileIdentity(stat: { dev: number; ino: number }): string {
  return `${stat.dev}:${stat.ino}`
}

function workspaceReplaced(rootPath: string): Error {
  return Object.assign(new Error(`workspace root was replaced: ${rootPath}`), { code: "WORKSPACE_REPLACED" })
}

/** Two paths name one workspace when their keys match. */
export function workspacePathKey(rootPath: string, platform = process.platform): string {
  return platform === "win32" ? rootPath.toLowerCase() : rootPath
}

function toDto(r: WorkspaceRecord): WorkspaceDto {
  return {
    path: r.canonicalRoot,
    displayName: r.displayName,
    createdAt: r.createdAt,
    lastOpenedAt: r.lastOpenedAt,
  }
}
