import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { workspacePathKey } from "./workspace-store.ts"

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
