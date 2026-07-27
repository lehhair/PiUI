import path from "node:path"
import chokidar, { type FSWatcher } from "chokidar"
import { lstat, readFile } from "node:fs/promises"
import type { EventPayloadsV2 } from "@piui/protocol"
import type { EventHub } from "./event-hub.ts"
import { invalidateGitCache } from "./git.ts"
import type { WorkspaceRecord } from "./workspace-store.ts"

const FLUSH_DELAY_MS = 80
const MAX_CHANGES_PER_EVENT = 512
const MAX_WATCHED_WORKSPACES = 32
const SKIP_SEGMENTS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo", "target"])

interface WatchedWorkspace {
  watcher: FSWatcher
  gitWatcher?: FSWatcher
  revision: number
  pending: Map<string, EventPayloadsV2["workspace.files.changed"]["changes"][number]>
  gitDirty: boolean
  rescan: boolean
  timer?: NodeJS.Timeout
  lastAccessedAt: number
}

export class WorkspaceWatcher {
  private readonly watched = new Map<string, WatchedWorkspace>()

  constructor(private readonly eventHub: EventHub) {}

  async dispose(): Promise<void> {
    const closing = [...this.watched.values()].map(async state => {
      if (state.timer) clearTimeout(state.timer)
      await Promise.all([state.watcher.close(), state.gitWatcher?.close()])
    })
    this.watched.clear()
    await Promise.all(closing)
  }

  watch(workspace: WorkspaceRecord): void {
    const existing = this.watched.get(workspace.canonicalRoot)
    if (existing) {
      existing.lastAccessedAt = Date.now()
      return
    }
    if (this.watched.size >= MAX_WATCHED_WORKSPACES) this.evictOldest()
    const state: WatchedWorkspace = {
      watcher: chokidar.watch(workspace.canonicalRoot, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        atomic: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
        ignored: candidate => shouldIgnore(workspace.canonicalRoot, candidate),
      }),
      revision: 0,
      pending: new Map(),
      gitDirty: false,
      rescan: false,
      lastAccessedAt: Date.now(),
    }
    this.watched.set(workspace.canonicalRoot, state)
    state.watcher.on("all", (event, absolutePath) => {
      const relative = path.relative(workspace.canonicalRoot, absolutePath).replace(/\\/g, "/")
      if (!relative || relative.startsWith("../")) return
      if (relative === ".git" || relative.startsWith(".git/")) {
        state.gitDirty = true
        this.schedule(workspace, state)
        return
      }
      const change = toChange(event, relative)
      if (!change) return
      state.gitDirty = true
      if (state.pending.size < MAX_CHANGES_PER_EVENT) state.pending.set(relative, change)
      else state.rescan = true
      this.schedule(workspace, state)
    })
    state.watcher.on("ready", () => {
      state.rescan = true
      state.gitDirty = true
      this.schedule(workspace, state)
    })
    state.watcher.on("error", error => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[piui-server] workspace watcher failed for ${workspace.canonicalRoot}: ${message}`)
      state.rescan = true
      this.schedule(workspace, state)
    })
    void this.attachLinkedGitWatcher(workspace, state)
  }

  private async attachLinkedGitWatcher(workspace: WorkspaceRecord, state: WatchedWorkspace): Promise<void> {
    const dotGit = path.join(workspace.canonicalRoot, ".git")
    try {
      if (!(await lstat(dotGit)).isFile()) return
      const definition = await readFile(dotGit, "utf8")
      const match = definition.match(/^gitdir:\s*(.+)\s*$/im)
      if (!match) return
      const gitDir = path.resolve(workspace.canonicalRoot, match[1]!)
      let commonDir = gitDir
      try {
        const common = (await readFile(path.join(gitDir, "commondir"), "utf8")).trim()
        if (common) commonDir = path.resolve(gitDir, common)
      } catch {
        /* standalone git dir */
      }
      const watcher = chokidar.watch([
        path.join(gitDir, "HEAD"),
        path.join(gitDir, "index"),
        path.join(commonDir, "packed-refs"),
        path.join(commonDir, "refs"),
      ], { ignoreInitial: true, persistent: true, followSymlinks: false, atomic: true })
      if (this.watched.get(workspace.canonicalRoot) !== state) {
        await watcher.close()
        return
      }
      state.gitWatcher = watcher
      watcher.on("all", () => {
        state.gitDirty = true
        this.schedule(workspace, state)
      })
      watcher.on("ready", () => {
        state.gitDirty = true
        this.schedule(workspace, state)
      })
      watcher.on("error", error => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[piui-server] linked worktree watcher failed for ${workspace.canonicalRoot}: ${message}`)
        state.gitDirty = true
        this.schedule(workspace, state)
      })
    } catch {
      /* not a linked worktree */
    }
  }

  private evictOldest(): void {
    const oldest = [...this.watched.entries()].sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0]
    if (!oldest) return
    const [key, state] = oldest
    if (state.timer) clearTimeout(state.timer)
    this.watched.delete(key)
    void Promise.all([state.watcher.close(), state.gitWatcher?.close()]).catch(() => undefined)
  }

  private schedule(workspace: WorkspaceRecord, state: WatchedWorkspace): void {
    if (state.timer) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.revision++
      if (state.pending.size > 0 || state.rescan) {
        this.eventHub.publishV2(
          { kind: "workspace", id: workspace.canonicalRoot },
          "workspace.files.changed",
          {
            workspacePath: workspace.canonicalRoot,
            revision: state.revision,
            changes: state.rescan ? [] : [...state.pending.values()],
            rescan: state.rescan,
          },
        )
      }
      if (state.gitDirty) {
        invalidateGitCache(workspace.canonicalRoot)
        this.eventHub.publishV2(
          { kind: "workspace", id: workspace.canonicalRoot },
          "workspace.git.updated",
          { workspacePath: workspace.canonicalRoot, revision: state.revision },
        )
      }
      state.pending.clear()
      state.gitDirty = false
      state.rescan = false
    }, FLUSH_DELAY_MS)
    state.timer.unref()
  }
}

function shouldIgnore(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate).replace(/\\/g, "/")
  if (!relative) return false
  if (/(?:^|\/)\.[^/]+\.piui-[^/]+\.tmp$/.test(relative) ||
    /(?:^|\/)[^/]+\.piui-backup-[^/]+$/.test(relative)) return true
  const segments = relative.split("/")
  if (segments.some(segment => SKIP_SEGMENTS.has(segment))) return true
  if (segments[0] !== ".git") return false
  if (relative === ".git") return false
  if (relative === ".git/refs" || relative === ".git/logs") return false
  return !isGitMetadata(relative)
}

function isGitMetadata(relative: string): boolean {
  return relative === ".git" || relative === ".git/HEAD" || relative === ".git/index" || relative === ".git/packed-refs" ||
    relative.startsWith(".git/refs/") || relative === ".git/logs/HEAD"
}

function toChange(
  event: string,
  relative: string,
): EventPayloadsV2["workspace.files.changed"]["changes"][number] | null {
  if (event === "add") return { path: relative, kind: "created", type: "file" }
  if (event === "addDir") return { path: relative, kind: "created", type: "directory" }
  if (event === "change") return { path: relative, kind: "changed", type: "file" }
  if (event === "unlink") return { path: relative, kind: "deleted", type: "file" }
  if (event === "unlinkDir") return { path: relative, kind: "deleted", type: "directory" }
  return null
}
