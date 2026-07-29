import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import type { EventEnvelope } from "@piui/protocol"
import { EventHub } from "../event-hub.ts"
import { WorkspaceStore } from "./workspace-store.ts"
import { WorkspaceWatcher } from "./workspace-watcher.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("WorkspaceWatcher", () => {
  it("publishes batched file and Git invalidation events", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-watch-"))
    roots.push(root)
    mkdirSync(path.join(root, ".git"))
    mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true })
    const store = new WorkspaceStore()
    const hub = new EventHub()
    const events: EventEnvelope[] = []
    const unsubscribe = hub.subscribe(event => events.push(event))
    const watcher = new WorkspaceWatcher(hub)
    const workspace = store.resolve(root)
    watcher.watch(workspace)
    try {
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.ok(events.some(event => event.channel === "workspace.files" && (event.payload as { rescan?: boolean }).rescan))
      events.length = 0
      writeFileSync(path.join(root, "created.txt"), "hello")
      await waitFor(() => events.some(event => event.channel === "workspace.files"))
      const fileEvent = events.find(event => event.channel === "workspace.files")
      assert.equal(fileEvent?.stream.id, workspace.canonicalRoot)
      assert.deepEqual((fileEvent?.payload as { changes?: unknown[] }).changes, [{ path: "created.txt", kind: "created", type: "file" }])
      assert.ok(events.some(event => event.channel === "workspace.git"))

      events.length = 0
      writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
      await waitFor(() => events.some(event => event.channel === "workspace.git"))
      assert.ok(!events.some(event => event.channel === "workspace.files"))

      events.length = 0
      const states = (watcher as unknown as { watched: Map<string, { watcher: { emit: (event: string, error: Error) => void } }> }).watched
      states.values().next().value?.watcher.emit("error", new Error("simulated watcher error"))
      await waitFor(() => events.some(event => event.channel === "workspace.files" && (event.payload as { rescan?: boolean }).rescan))

      events.length = 0
      writeFileSync(path.join(root, ".git", "refs", "heads", "main"), "0123456789\n")
      await waitFor(() => events.some(event => event.channel === "workspace.git"))
      assert.ok(!events.some(event => event.channel === "workspace.files"))
    } finally {
      unsubscribe()
      await watcher.dispose()
    }
  })

  it("observes Git metadata stored outside a linked worktree", async () => {
    const main = mkdtempSync(path.join(tmpdir(), "piui-watch-main-"))
    const worktree = `${main}-linked`
    roots.push(main, worktree)
    git(main, "init", "-b", "main")
    git(main, "config", "user.name", "PiUI Test")
    git(main, "config", "user.email", "piui@example.invalid")
    writeFileSync(path.join(main, "tracked.txt"), "base\n")
    git(main, "add", "tracked.txt")
    git(main, "commit", "-m", "initial")
    git(main, "worktree", "add", "-b", "feature", worktree)
    const store = new WorkspaceStore()
    const hub = new EventHub()
    const events: EventEnvelope[] = []
    const unsubscribe = hub.subscribe(event => events.push(event))
    const watcher = new WorkspaceWatcher(hub)
    watcher.watch(store.resolve(worktree))
    try {
      await new Promise(resolve => setTimeout(resolve, 350))
      events.length = 0
      writeFileSync(path.join(worktree, "tracked.txt"), "linked\n")
      git(worktree, "add", "tracked.txt")
      await new Promise(resolve => setTimeout(resolve, 200))
      events.length = 0
      git(worktree, "commit", "-m", "linked")
      await waitFor(() => events.some(event => event.channel === "workspace.git"))
    } finally {
      unsubscribe()
      await watcher.dispose()
      try { git(main, "worktree", "remove", "--force", worktree) } catch { /* cleanup below */ }
    }
  })
})

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for watcher event")
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true })
}
