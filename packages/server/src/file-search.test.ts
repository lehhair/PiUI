import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { searchFilesByName } from "./file-search.ts"
import type { WorkspaceRecord } from "./workspace-store.ts"

describe("searchFilesByName", () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-search-"))
  mkdirSync(path.join(root, "src"))
  writeFileSync(path.join(root, "src", "hello.ts"), "export {}\n")
  writeFileSync(path.join(root, "README.md"), "# x\n")
  mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true })
  writeFileSync(path.join(root, "node_modules", "pkg", "hello.ts"), "skip\n")

  const ws: WorkspaceRecord = {
    id: "w",
    displayName: "t",
    canonicalRoot: root,
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  }

  after(() => rmSync(root, { recursive: true, force: true }))

  it("finds by name and skips node_modules", () => {
    const hits = searchFilesByName(ws, "hello")
    assert.ok(hits.some(p => p.includes("src/hello.ts")))
    assert.ok(!hits.some(p => p.includes("node_modules")))
  })
})
