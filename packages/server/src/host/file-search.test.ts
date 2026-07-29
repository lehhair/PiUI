import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { searchFilesByName, searchWorkspaceText } from "./file-search.ts"
import type { WorkspaceRecord } from "./workspace-store.ts"

describe("searchFilesByName", () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-search-"))
  mkdirSync(path.join(root, "src"))
  writeFileSync(path.join(root, "src", "hello.ts"), "export {}\n")
  writeFileSync(path.join(root, "src", "message.ts"), "const first = 'PiUI'\nconst second = 'piui client'\n")
  writeFileSync(path.join(root, "src", "unicode.txt"), "你好 PiUI\n")
  writeFileSync(path.join(root, "src", "casefold.txt"), "İX\n")
  writeFileSync(path.join(root, "src", "binary.dat"), Buffer.from([0, 80, 105, 85, 73]))
  writeFileSync(path.join(root, "README.md"), "# x\n")
  mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true })
  writeFileSync(path.join(root, "node_modules", "pkg", "hello.ts"), "skip\n")

  const ws: WorkspaceRecord = {
    displayName: "t",
    canonicalRoot: root,
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  }

  after(() => rmSync(root, { recursive: true, force: true }))

  it("finds by name and skips node_modules", async () => {
    const { paths: hits, stats } = await searchFilesByName(ws, "hello")
    assert.ok(hits.some(p => p.includes("src/hello.ts")))
    assert.ok(!hits.some(p => p.includes("node_modules")))
    assert.equal(stats.truncated, false)
  })

  it("finds text with line metadata and skips binary files", async () => {
    const { matches: hits, stats } = await searchWorkspaceText(ws, "piui")

    assert.ok(hits.some(hit => hit.path.text === "src/message.ts" && hit.line_number === 1))
    assert.ok(hits.some(hit => hit.path.text === "src/message.ts" && hit.line_number === 2))
    const unicodeHit = hits.find(hit => hit.path.text === "src/unicode.txt")
    assert.equal(unicodeHit?.submatches[0]?.start, 7)
    assert.equal(unicodeHit?.submatches[0]?.end, 11)
    assert.ok(!hits.some(hit => hit.path.text.includes("binary.dat")))
    assert.ok(!hits.some(hit => hit.path.text.includes("node_modules")))
    assert.ok(stats.scannedFiles >= 1)

    const casefold = await searchWorkspaceText(ws, "x")
    const casefoldHit = casefold.matches.find(hit => hit.path.text === "src/casefold.txt")
    assert.equal(casefoldHit?.submatches[0]?.start, 2)
    assert.equal(casefoldHit?.submatches[0]?.end, 3)
    assert.equal(casefoldHit?.submatches[0]?.match.text, "X")
  })

  it("reports result truncation and honors cancellation", async () => {
    const limited = await searchFilesByName(ws, "src", { limit: 1 })
    assert.equal(limited.paths.length, 1)
    assert.equal(limited.stats.truncated, true)
    assert.equal(limited.stats.limitReason, "results")

    const controller = new AbortController()
    controller.abort()
    await assert.rejects(searchWorkspaceText(ws, "piui", { signal: controller.signal }), error =>
      (error as { code?: string }).code === "REQUEST_ABORTED")
  })
})
