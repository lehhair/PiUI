import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it, after } from "node:test"
import { normalizeRelativePath, resolveWorkspacePath, PathSafetyError } from "./path-safety.ts"

describe("normalizeRelativePath", () => {
  it("accepts empty as root", () => {
    assert.equal(normalizeRelativePath(""), "")
    assert.equal(normalizeRelativePath("."), "")
  })

  it("normalizes dots and slashes", () => {
    assert.equal(normalizeRelativePath("./a/b"), "a/b")
    assert.equal(normalizeRelativePath("a//b/./c"), "a/b/c")
    assert.equal(normalizeRelativePath("a\\b"), "a/b")
  })

  it("rejects absolute and drive paths", () => {
    assert.throws(() => normalizeRelativePath("/etc/passwd"), PathSafetyError)
    assert.throws(() => normalizeRelativePath("C:\\Windows"), PathSafetyError)
    assert.throws(() => normalizeRelativePath("\\\\server\\share"), PathSafetyError)
  })

  it("rejects Windows alternate data stream segments", () => {
    assert.throws(() => normalizeRelativePath("file.txt:secret", "win32"), /alternate data streams/)
    assert.equal(normalizeRelativePath("file.txt:secret", "linux"), "file.txt:secret")
  })

  it("rejects escape via ..", () => {
    assert.throws(() => normalizeRelativePath(".."), PathSafetyError)
    assert.throws(() => normalizeRelativePath("a/../../b"), PathSafetyError)
  })

  it("allows internal .. that stays inside", () => {
    assert.equal(normalizeRelativePath("a/b/../c"), "a/c")
  })
})

describe("resolveWorkspacePath", () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-ws-"))
  mkdirSync(path.join(root, "src"))
  writeFileSync(path.join(root, "src", "main.ts"), "export {}\n")
  writeFileSync(path.join(root, "readme.md"), "# hi\n")

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("resolves existing file inside workspace", () => {
    const r = resolveWorkspacePath(root, "src/main.ts")
    assert.equal(r.exists, true)
    assert.equal(r.relative, "src/main.ts")
    assert.ok(r.absolute.includes("main.ts"))
  })

  it("lists root", () => {
    const r = resolveWorkspacePath(root, "")
    assert.equal(r.exists, true)
  })

  it("blocks symlink escape when possible", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "piui-out-"))
    writeFileSync(path.join(outside, "secret.txt"), "x")
    const link = path.join(root, "leak")
    try {
      symlinkSync(outside, link, "junction")
    } catch {
      // platform may not allow — skip
      rmSync(outside, { recursive: true, force: true })
      return
    }
    try {
      assert.throws(
        () => resolveWorkspacePath(root, "leak/secret.txt"),
        (e: unknown) => e instanceof PathSafetyError,
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("resolves missing targets through an internal directory link", () => {
    const link = path.join(root, "src-alias")
    try {
      symlinkSync(path.join(root, "src"), link, "junction")
    } catch {
      return
    }
    try {
      const resolved = resolveWorkspacePath(root, "src-alias/new.ts")
      assert.equal(resolved.exists, false)
      assert.equal(resolved.absolute, path.join(root, "src", "new.ts"))
    } finally {
      rmSync(link, { recursive: true, force: true })
    }
  })
})
