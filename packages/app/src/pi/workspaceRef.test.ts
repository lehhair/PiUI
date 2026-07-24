import { describe, expect, it } from "vitest"
import { parsePiWorkspaceId, toPiWorkspaceDirectory, isPiWorkspaceDirectory } from "./workspaceRef"

describe("workspaceRef", () => {
  it("roundtrips workspace id", () => {
    const dir = toPiWorkspaceDirectory("ws-1")
    expect(dir).toBe("piws:ws-1")
    expect(parsePiWorkspaceId(dir)).toBe("ws-1")
    expect(isPiWorkspaceDirectory(dir)).toBe(true)
    expect(parsePiWorkspaceId("C:/foo")).toBeNull()
  })
})
