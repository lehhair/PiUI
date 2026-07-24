import { randomUUID } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import type { WorkspaceDtoV1 } from "@piui/protocol"

export interface WorkspaceRecord {
  id: string
  displayName: string
  canonicalRoot: string
  createdAt: string
  lastOpenedAt: string
}

/** In-memory Phase 1 store. SQLite comes later. */
export class WorkspaceStore {
  private readonly byId = new Map<string, WorkspaceRecord>()
  private readonly byRoot = new Map<string, string>()

  list(): WorkspaceDtoV1[] {
    return [...this.byId.values()].map(toDto)
  }

  get(id: string): WorkspaceRecord | undefined {
    return this.byId.get(id)
  }

  register(rootPath: string, displayName?: string): WorkspaceRecord {
    const abs = path.resolve(rootPath)
    if (!existsSync(abs)) {
      throw Object.assign(new Error(`workspace root not found: ${abs}`), {
        code: "INVALID_REQUEST" as const,
      })
    }
    const st = statSync(abs)
    if (!st.isDirectory()) {
      throw Object.assign(new Error("workspace root must be a directory"), {
        code: "INVALID_REQUEST" as const,
      })
    }
    const key = abs.toLowerCase()
    const existingId = this.byRoot.get(key)
    if (existingId) {
      const rec = this.byId.get(existingId)!
      rec.lastOpenedAt = new Date().toISOString()
      return rec
    }
    const now = new Date().toISOString()
    const rec: WorkspaceRecord = {
      id: randomUUID(),
      displayName: displayName?.trim() || path.basename(abs) || abs,
      canonicalRoot: abs,
      createdAt: now,
      lastOpenedAt: now,
    }
    this.byId.set(rec.id, rec)
    this.byRoot.set(key, rec.id)
    return rec
  }
}

function toDto(r: WorkspaceRecord): WorkspaceDtoV1 {
  return {
    id: r.id,
    displayName: r.displayName,
    createdAt: r.createdAt,
    lastOpenedAt: r.lastOpenedAt,
  }
}
