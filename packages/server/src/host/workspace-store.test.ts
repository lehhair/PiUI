import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { WorkspaceStore, workspacePathKey } from "./workspace-store.ts"

describe("workspacePathKey", () => {
  it("normalizes case only on Windows", () => {
    assert.equal(workspacePathKey("C:\\Work\\Project", "win32"), "c:\\work\\project")
    assert.equal(workspacePathKey("/home/user/Project", "linux"), "/home/user/Project")
    assert.notEqual(
      workspacePathKey("/home/user/Project", "linux"),
      workspacePathKey("/home/user/project", "linux"),
    )
  })
})

describe("workspace identity", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it("identifies a workspace by its canonical path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-ws-id-"))
    roots.push(root)

    // A fresh store stands in for a restarted server. Nothing is persisted, yet
    // the same directory resolves to the same identity, because the path is it.
    const before = new WorkspaceStore().resolve(root)
    const after = new WorkspaceStore().resolve(root)
    assert.equal(after.canonicalRoot, before.canonicalRoot)
    assert.equal(before.canonicalRoot, realpathSync.native(root))
  })

  it("resolves paths that differ only in form onto one workspace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-ws-form-"))
    roots.push(root)
    const store = new WorkspaceStore()
    const direct = store.resolve(root)
    const viaDot = store.resolve(path.join(root, "."))
    assert.equal(viaDot.canonicalRoot, direct.canonicalRoot)
    assert.equal(store.list().length, 1, "one directory must not appear twice")
  })

  it("keeps metadata when the same path is resolved again", () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-ws-dup-"))
    roots.push(root)
    const store = new WorkspaceStore()
    const first = store.resolve(root, "Custom name")
    const second = store.resolve(root)
    assert.equal(second.canonicalRoot, first.canonicalRoot)
    assert.equal(second.displayName, "Custom name", "resolving again must not reset metadata")
    assert.equal(store.list().length, 1)
  })

  it("rejects a path that is not an existing directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-ws-bad-"))
    roots.push(root)
    const file = path.join(root, "not-a-dir.txt")
    writeFileSync(file, "x")
    const store = new WorkspaceStore()
    assert.throws(() => store.resolve(file), /must be a directory/)
    assert.throws(() => store.resolve(path.join(root, "missing")), /not found/)
  })

  it("finds a known workspace without touching the filesystem", () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-ws-find-"))
    roots.push(root)
    const store = new WorkspaceStore()
    assert.equal(store.find(root), undefined)
    store.resolve(root)
    assert.equal(store.find(root)?.canonicalRoot, realpathSync.native(root))
  })

  it("keeps an explicitly closed workspace closed until it is opened again", () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-ws-closed-"))
    roots.push(root)
    const store = new WorkspaceStore()
    store.resolve(root)

    assert.equal(store.remove(root), true)
    assert.equal(store.isClosed(root), true)
    assert.equal(store.find(root), undefined)

    const reopened = store.resolve(root)
    assert.equal(store.isClosed(root), false)
    assert.equal(reopened.canonicalRoot, realpathSync.native(root))
  })

  it("rejects a known root replaced by a symlink", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "piui-ws-replaced-"))
    const root = path.join(parent, "root")
    const outside = path.join(parent, "outside")
    mkdirSync(root)
    mkdirSync(outside)
    roots.push(parent)
    const store = new WorkspaceStore()
    store.resolve(root)
    renameSync(root, path.join(parent, "moved"))
    symlinkSync(outside, root, process.platform === "win32" ? "junction" : "dir")
    assert.throws(() => store.resolve(root), /workspace root was replaced/)
  })

  it("rejects an operation using a known root after replacement", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "piui-ws-operation-replaced-"))
    const root = path.join(parent, "root")
    const outside = path.join(parent, "outside")
    mkdirSync(root)
    mkdirSync(outside)
    roots.push(parent)
    const store = new WorkspaceStore()
    const record = store.resolve(root)
    renameSync(root, path.join(parent, "moved"))
    symlinkSync(outside, root, process.platform === "win32" ? "junction" : "dir")
    assert.throws(() => store.assertCurrent(record), /workspace root was replaced/)
  })
})
