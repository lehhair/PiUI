import path from "node:path"
import chokidar, { type FSWatcher } from "chokidar"
import { lstat, readFile, readdir } from "node:fs/promises"
import type { JsonObject } from "@piui/protocol"

type WorkspaceFileChange = { path: string; kind: "created" | "changed" | "deleted"; type: "file" | "directory" }
import type { EventHub } from "../event-hub.ts"
import { invalidateGitCache } from "./git.ts"
import { workspacePathKey, type WorkspaceRecord } from "./workspace-store.ts"

const FLUSH_DELAY_MS = 80
const MAX_CHANGES_PER_EVENT = 512
const MAX_WATCHED_WORKSPACES = 32
// chokidar recursively enumerates the tree and opens one fs.watch handle per
// directory. Past this many directories the initial scan alone can take minutes
// and exhaust memory (a dev drive root such as E:\dev easily holds 20k+
// directories), so such workspaces are not recursively watched at all.
const MAX_WATCH_DIRECTORIES = 4_000
const PRE_SCAN_BATCH = 64
const SKIP_SEGMENTS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo", "target"])

interface WatchedWorkspace {
  watcher?: FSWatcher
  gitWatcher?: FSWatcher
  revision: number
  pending: Map<string, WorkspaceFileChange>
  gitDirty: boolean
  rescan: boolean
  timer?: NodeJS.Timeout
  lastAccessedAt: number
}

export class WorkspaceWatcher {
  private readonly watched = new Map<string, WatchedWorkspace>()

  constructor(
    private readonly eventHub: EventHub,
    private readonly maxWatchDirectories = MAX_WATCH_DIRECTORIES,
  ) {}

  async dispose(): Promise<void> {
    const closing = [...this.watched.values()].map(async state => {
      if (state.timer) clearTimeout(state.timer)
      await Promise.all([state.watcher?.close(), state.gitWatcher?.close()])
    })
    this.watched.clear()
    await Promise.all(closing)
  }

  watch(workspace: WorkspaceRecord): void {
    const key = workspacePathKey(workspace.canonicalRoot)
    const existing = this.watched.get(key)
    if (existing) {
      existing.lastAccessedAt = Date.now()
      return
    }
    if (this.watched.size >= MAX_WATCHED_WORKSPACES) this.evictOldest()
    const state: WatchedWorkspace = {
      revision: 0,
      pending: new Map(),
      gitDirty: false,
      rescan: false,
      lastAccessedAt: Date.now(),
    }
    this.watched.set(key, state)
    void this.establishWatch(workspace, key, state)
  }

  /**
   * Runs a bounded pre-scan before attaching chokidar. A giant workspace (for
   * example the root of a dev drive with tens of thousands of directories)
   * would otherwise make chokidar enumerate the whole tree and open a watch
   * handle per directory, flooding the server's event loop until it appears
   * completely frozen with no error in the log. When the tree exceeds the cap
   * the recursive watcher is skipped with a warning: the workspace stays fully
   * usable, it simply does not push file-change events.
   */
  private async establishWatch(workspace: WorkspaceRecord, key: string, state: WatchedWorkspace): Promise<void> {
    const directories = await countWatchableDirectories(workspace.canonicalRoot, this.maxWatchDirectories + 1)
    if (this.watched.get(key) !== state) return // evicted or disposed while scanning
    if (directories > this.maxWatchDirectories) {
      this.watched.delete(key)
      console.warn(
        `[piui-server] skipping recursive watch for ${workspace.canonicalRoot}: ` +
          `${directories} directories exceeds the cap of ${this.maxWatchDirectories}`,
      )
      return
    }
    state.watcher = chokidar.watch(workspace.canonicalRoot, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      ignored: candidate => shouldIgnore(workspace.canonicalRoot, candidate),
    })
    if (this.watched.get(key) !== state) {
      // Evicted or disposed between the pre-scan and watcher creation — do not leak it.
      await state.watcher.close()
      state.watcher = undefined
      return
    }
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
      if (this.watched.get(workspacePathKey(workspace.canonicalRoot)) !== state) {
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

  unwatch(workspace: WorkspaceRecord): void {
    const key = workspacePathKey(workspace.canonicalRoot)
    const state = this.watched.get(key)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    this.watched.delete(key)
    void Promise.all([state.watcher?.close(), state.gitWatcher?.close()]).catch(() => undefined)
  }

  private evictOldest(): void {
    const oldest = [...this.watched.entries()].sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0]
    if (!oldest) return
    const [key, state] = oldest
    if (state.timer) clearTimeout(state.timer)
    this.watched.delete(key)
    void Promise.all([state.watcher?.close(), state.gitWatcher?.close()]).catch(() => undefined)
  }

  private schedule(workspace: WorkspaceRecord, state: WatchedWorkspace): void {
    if (state.timer) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.revision++
      if (state.pending.size > 0 || state.rescan) {
        this.eventHub.publish(
          { kind: "workspace", id: workspace.canonicalRoot },
          "workspace.files",
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
        this.eventHub.publish(
          { kind: "workspace", id: workspace.canonicalRoot },
          "workspace.git",
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

/**
 * Bounded BFS counting the directories chokidar would watch (same skip rules,
 * symlinks pruned), stopping once `cap` is reached. Exact below the cap;
 * returns a value >= cap once the tree is known to be that large.
 */
export async function countWatchableDirectories(root: string, cap: number): Promise<number> {
  let count = 1 // the root itself
  const seen = new Set<string>([root])
  let frontier = [root]
  while (frontier.length > 0 && count < cap) {
    const batch = frontier.splice(0, PRE_SCAN_BATCH)
    const batches = await Promise.all(
      batch.map(async dir => {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return []
        }
        const children: string[] = []
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue
          const child = path.join(dir, entry.name)
          if (seen.has(child)) continue
          seen.add(child)
          if (shouldIgnore(root, child)) continue
          children.push(child)
        }
        return children
      }),
    )
    for (const children of batches) {
      if (count >= cap) break
      frontier.push(...children)
      count += children.length
    }
  }
  return count
}

function isGitMetadata(relative: string): boolean {
  return relative === ".git" || relative === ".git/HEAD" || relative === ".git/index" || relative === ".git/packed-refs" ||
    relative.startsWith(".git/refs/") || relative === ".git/logs/HEAD"
}

function toChange(
  event: string,
  relative: string,
): WorkspaceFileChange | null {
  if (event === "add") return { path: relative, kind: "created", type: "file" }
  if (event === "addDir") return { path: relative, kind: "created", type: "directory" }
  if (event === "change") return { path: relative, kind: "changed", type: "file" }
  if (event === "unlink") return { path: relative, kind: "deleted", type: "file" }
  if (event === "unlinkDir") return { path: relative, kind: "deleted", type: "directory" }
  return null
}
