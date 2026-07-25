import { describe, expect, it } from "vitest"
import { isSameDirectory } from "./directoryUtils"

describe("isSameDirectory", () => {
  it("ignores case and slash style for Windows paths", () => {
    expect(isSameDirectory("E:\\Dev\\Project", "e:/dev/project/")).toBe(true)
  })

  it("preserves case for POSIX paths", () => {
    expect(isSameDirectory("/home/user/Project", "/home/user/Project/")).toBe(true)
    expect(isSameDirectory("/home/user/Project", "/home/user/project")).toBe(false)
    expect(isSameDirectory("/", undefined)).toBe(false)
  })
})
