import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  listFiles,
  moveWorkspaceEntry,
  readFileContent,
  writeFileContent,
} from "./files.ts"
import type { WorkspaceRecord } from "./workspace-store.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("workspace files", () => {
  it("lists deterministically with bounded cursor pagination", async () => {
    const { root, workspace } = fixture()
    mkdirSync(path.join(root, "folder"))
    for (const name of ["c.txt", "a.txt", "b.txt"]) writeFileSync(path.join(root, name), name)

    const first = await listFiles(workspace, "", { limit: 2 })
    assert.equal(first.total, 4)
    assert.equal(first.truncated, true)
    assert.ok(first.nextCursor)
    const second = await listFiles(workspace, "", { limit: 2, cursor: first.nextCursor })
    assert.equal(second.truncated, false)
    assert.deepEqual(
      [...first.entries, ...second.entries].map(entry => entry.name).sort(),
      ["a.txt", "b.txt", "c.txt", "folder"],
    )
    await assert.rejects(listFiles(workspace, "", { cursor: "%%%" }), /invalid directory cursor/)
  })

  it("round-trips UTF-8 and binary files with metadata", async () => {
    const { root, workspace } = fixture()
    writeFileSync(path.join(root, "hello.txt"), "你好 PiUI\n")
    writeFileSync(path.join(root, "image.png"), Buffer.from([0, 1, 2, 255]))

    const text = await readFileContent(workspace, "hello.txt")
    assert.equal(text.type, "text")
    assert.equal(text.encoding, "utf-8")
    assert.equal(text.mimeType, "text/plain")
    const binary = await readFileContent(workspace, "image.png")
    assert.equal(binary.type, "binary")
    assert.equal(binary.encoding, "base64")
    assert.deepEqual(Buffer.from(binary.content, "base64"), Buffer.from([0, 1, 2, 255]))
    writeFileSync(path.join(root, " spaced .txt"), "exact")
    assert.equal((await readFileContent(workspace, " spaced .txt")).content, "exact")
  })

  it("rejects a directory cursor after the directory changes", async () => {
    const { root, workspace } = fixture()
    writeFileSync(path.join(root, "a.txt"), "a")
    writeFileSync(path.join(root, "b.txt"), "b")
    const first = await listFiles(workspace, "", { limit: 1 })
    writeFileSync(path.join(root, "c.txt"), "c")
    await assert.rejects(listFiles(workspace, "", { limit: 1, cursor: first.nextCursor }), error =>
      (error as { code?: string }).code === "STALE_REVISION")
  })

  it("serializes concurrent ETag writes so one stale writer loses", async () => {
    const { root, workspace } = fixture()
    writeFileSync(path.join(root, "shared.txt"), "base")
    const initial = await readFileContent(workspace, "shared.txt")
    const results = await Promise.allSettled([
      writeFileContent(workspace, "shared.txt", "first", { ifMatch: initial.etag }),
      writeFileContent(workspace, "shared.txt", "second", { ifMatch: initial.etag }),
    ])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult
    assert.equal((rejected.reason as { code?: string }).code, "STALE_REVISION")
    assert.ok(["first", "second"].includes(readFileSync(path.join(root, "shared.txt"), "utf8")))
  })

  it("creates, moves, and deletes files and directories", async () => {
    const { root, workspace } = fixture()
    await createWorkspaceEntry(workspace, "src/nested", "directory")
    await createWorkspaceEntry(workspace, "src/nested/a.txt", "file", { content: "a" })
    const moved = await moveWorkspaceEntry(workspace, "src/nested/a.txt", "src/b.txt")
    assert.deepEqual(moved, { path: "src/b.txt", type: "file" })
    assert.equal(readFileSync(path.join(root, "src", "b.txt"), "utf8"), "a")
    await deleteWorkspaceEntry(workspace, "src/b.txt")
    await assert.rejects(deleteWorkspaceEntry(workspace, "src", false), error =>
      (error as { code?: string }).code === "FILE_CONFLICT")
    await deleteWorkspaceEntry(workspace, "src", true)
  })

  it("supports a case-only rename on Windows", { skip: process.platform !== "win32" }, async () => {
    const { root, workspace } = fixture()
    writeFileSync(path.join(root, "Readme.txt"), "case")
    const moved = await moveWorkspaceEntry(workspace, "Readme.txt", "README.txt")
    assert.equal(moved.path, "README.txt")
    assert.equal(readFileSync(path.join(root, "README.txt"), "utf8"), "case")
  })

  it("rejects path escapes and malformed base64", async () => {
    const { workspace } = fixture()
    await assert.rejects(writeFileContent(workspace, "../escape", "x"), /escapes workspace/)
    await assert.rejects(writeFileContent(workspace, "bad.bin", "%%%", { encoding: "base64" }), /invalid base64/)
  })

  it("writes through an internal directory link at its physical target", async () => {
    const { root, workspace } = fixture()
    const physical = path.join(root, "physical")
    const alias = path.join(root, "alias")
    mkdirSync(physical)
    try {
      symlinkSync(physical, alias, "junction")
    } catch {
      return
    }
    await writeFileContent(workspace, "alias/new.txt", "physical")
    assert.equal(readFileSync(path.join(physical, "new.txt"), "utf8"), "physical")
  })
})

function fixture(): { root: string; workspace: WorkspaceRecord } {
  const root = mkdtempSync(path.join(tmpdir(), "piui-files-"))
  roots.push(root)
  return {
    root,
    workspace: {
      canonicalRoot: root,
      displayName: "fixture",
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    },
  }
}
