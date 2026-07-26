import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { WorkspaceStore, workspaceIdFor, workspacePathKey } from "./workspace-store.ts"

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

  it("derives the id from the path so it survives a restart", () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-ws-id-"))
    roots.push(root)

    const before = new WorkspaceStore().register(root)
    // A fresh store stands in for a restarted server: clients holding the old
    // id must still resolve to the same workspace.
    const after = new WorkspaceStore().register(root)
    assert.equal(after.id, before.id)
    assert.equal(new WorkspaceStore().get(before.id), undefined, "a new store starts empty")
    assert.equal(new WorkspaceStore().register(root).id, before.id)
  })

  it("gives different paths different ids", () => {
    const first = mkdtempSync(path.join(tmpdir(), "piui-ws-a-"))
    const second = mkdtempSync(path.join(tmpdir(), "piui-ws-b-"))
    roots.push(first, second)
    const store = new WorkspaceStore()
    assert.notEqual(store.register(first).id, store.register(second).id)
  })

  it("matches the case rules used for deduplication", () => {
    // Otherwise two ids could exist for one workspace on Windows.
    assert.equal(workspaceIdFor("C:\\Work\\Project", "win32"), workspaceIdFor("c:\\work\\project", "win32"))
    assert.notEqual(workspaceIdFor("/home/u/Project", "linux"), workspaceIdFor("/home/u/project", "linux"))
  })

  it("keeps re-registering the same path on one record", () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-ws-dup-"))
    roots.push(root)
    const store = new WorkspaceStore()
    const first = store.register(root, "Custom name")
    const second = store.register(root)
    assert.equal(second.id, first.id)
    assert.equal(second.displayName, "Custom name", "re-registering must not reset metadata")
    assert.equal(store.list().length, 1)
  })
})
