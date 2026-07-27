import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import {
  getGitDiff,
  getGitFileDiff,
  getGitInfo,
  getGitStatus,
  invalidateGitCache,
  parseNumstatZ,
  parsePorcelainStatus,
} from "./git.ts"

const roots: string[] = []
afterEach(() => {
  invalidateGitCache()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("parsePorcelainStatus", () => {
  it("maps common codes", () => {
    const items = parsePorcelainStatus(
      [" M src/a.ts", "A  src/b.ts", " D src/c.ts", "?? new.txt"].join("\n"),
    )
    assert.equal(items.find(i => i.path === "src/a.ts")?.status, "modified")
    assert.equal(items.find(i => i.path === "src/b.ts")?.status, "added")
    assert.equal(items.find(i => i.path === "src/c.ts")?.status, "deleted")
    assert.equal(items.find(i => i.path === "new.txt")?.status, "untracked")
  })

  it("consumes the second NUL path of a rename", () => {
    const items = parsePorcelainStatus("R  new name.ts\0old name.ts\0 M other.ts\0")
    assert.deepEqual(items[0], {
      path: "new name.ts",
      oldPath: "old name.ts",
      status: "renamed",
      indexStatus: "R",
      worktreeStatus: " ",
      staged: true,
      unstaged: false,
    })
    assert.equal(items[1]?.path, "other.ts")
  })
})

describe("Git workspace API", () => {
  it("returns net worktree changes and a displayable file patch", async () => {
    const root = repository()
    writeFileSync(path.join(root, "tracked.txt"), "base\nnext\n")
    invalidateGitCache(root)

    const info = await getGitInfo(root)
    assert.equal(info.branch, "main")
    assert.equal(info.defaultBranch, "main")
    const diff = await getGitDiff(root, "git")
    assert.deepEqual(diff.files[0], {
      file: "tracked.txt",
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
    })
    const file = await getGitFileDiff(root, "git", "tracked.txt")
    assert.match(file.patch, /^diff --git/m)
    assert.match(file.patch, /^\+next$/m)
  })

  it("parses staged renames and does not double-count opposing index changes", async () => {
    const root = repository()
    renameSync(path.join(root, "tracked.txt"), path.join(root, "renamed.txt"))
    git(root, "add", "-A")
    invalidateGitCache(root)
    const status = await getGitStatus(root)
    assert.equal(status.items[0]?.status, "renamed")
    assert.equal(status.items[0]?.path, "renamed.txt")
    assert.equal(status.items[0]?.oldPath, "tracked.txt")

    git(root, "reset", "--hard", "HEAD")
    writeFileSync(path.join(root, "tracked.txt"), "staged\n")
    git(root, "add", "tracked.txt")
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    invalidateGitCache(root)
    assert.deepEqual((await getGitDiff(root, "git")).files, [])
  })

  it("includes untracked files and generates their patch lazily", async () => {
    const root = repository()
    writeFileSync(path.join(root, "new file.txt"), "new\ncontent\n")
    invalidateGitCache(root)
    const diff = await getGitDiff(root, "git")
    assert.equal(diff.files.find(file => file.file === "new file.txt")?.status, "untracked")
    const file = await getGitFileDiff(root, "git", "new file.txt")
    assert.match(file.patch, /^\+new$/m)
  })

  it("resolves a local default branch and compares committed branch changes", async () => {
    const root = repository()
    git(root, "checkout", "-b", "feature")
    writeFileSync(path.join(root, "tracked.txt"), "feature\n")
    git(root, "add", "tracked.txt")
    git(root, "commit", "-m", "feature")
    invalidateGitCache(root)
    const diff = await getGitDiff(root, "branch")
    assert.equal(diff.baseRef, "refs/heads/main")
    assert.match(diff.baseCommit ?? "", /^[0-9a-f]{40,64}$/)
    assert.equal(diff.files[0]?.file, "tracked.txt")
    assert.equal(diff.files[0]?.status, "modified")
  })

  it("marks binary changes instead of fabricating line counts", async () => {
    const root = repository()
    writeFileSync(path.join(root, "binary.dat"), Buffer.from([0, 1, 2]))
    git(root, "add", "binary.dat")
    git(root, "commit", "-m", "binary")
    writeFileSync(path.join(root, "binary.dat"), Buffer.from([0, 3, 4]))
    invalidateGitCache(root)
    const binary = (await getGitDiff(root, "git")).files.find(file => file.file === "binary.dat")
    assert.equal(binary?.binary, true)
    assert.equal(binary?.additions, 0)
    assert.equal(binary?.deletions, 0)
  })

  it("disables repository-configured filesystem monitor commands", async () => {
    const root = repository()
    writeFileSync(path.join(root, "malicious.cjs"), "require('node:fs').writeFileSync('fsmonitor-ran', 'yes')\n")
    git(root, "config", "core.fsmonitor", "node malicious.cjs")
    invalidateGitCache(root)
    await getGitStatus(root)
    assert.equal(existsSync(path.join(root, "fsmonitor-ran")), false)
  })

  it("does not mistake a feature upstream for the default branch", async () => {
    const root = repository()
    git(root, "checkout", "-b", "feature")
    git(root, "update-ref", "refs/remotes/origin/feature", "HEAD")
    git(root, "remote", "add", "origin", root)
    git(root, "branch", "--set-upstream-to=origin/feature", "feature")
    invalidateGitCache(root)
    const info = await getGitInfo(root)
    assert.equal(info.upstream, "origin/feature")
    assert.equal(info.defaultBranch, "main")
  })

  it("preserves tabs in numstat file names", () => {
    const fileName = "tab\tname.txt"
    const file = parseNumstatZ(`1\t0\t${fileName}\0`).get(fileName)
    assert.equal(file?.additions, 1)
  })

  it("propagates cancellation instead of caching a false non-repository result", async () => {
    const root = repository()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(getGitInfo(root, controller.signal), error =>
      (error as { code?: string }).code === "REQUEST_ABORTED")
    assert.equal((await getGitInfo(root)).root, true)
  })
})

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "piui-git-"))
  roots.push(root)
  git(root, "init", "-b", "main")
  git(root, "config", "user.name", "PiUI Test")
  git(root, "config", "user.email", "piui@example.invalid")
  writeFileSync(path.join(root, "tracked.txt"), "base\n")
  git(root, "add", "tracked.txt")
  git(root, "commit", "-m", "initial")
  assert.equal(readFileSync(path.join(root, "tracked.txt"), "utf8"), "base\n")
  return root
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true })
}
