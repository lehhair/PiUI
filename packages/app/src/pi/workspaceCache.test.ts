import { describe, expect, it } from "vitest"
import { cacheWorkspace, getWorkspaceIdByPath } from "./workspaceCache"

describe("workspaceCache", () => {
  it("treats Windows paths as case insensitive", () => {
    cacheWorkspace("C:/Work/Project", "windows-project")
    expect(getWorkspaceIdByPath("c:\\work\\project")).toBe("windows-project")
  })

  it("preserves case for POSIX paths", () => {
    cacheWorkspace("/home/user/Project", "posix-project")
    expect(getWorkspaceIdByPath("/home/user/Project")).toBe("posix-project")
    expect(getWorkspaceIdByPath("/home/user/project")).toBeUndefined()
  })
})
