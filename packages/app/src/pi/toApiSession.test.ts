import { describe, expect, it } from "vitest"
import { toApiSession } from "./toApiSession"

describe("toApiSession", () => {
  it("maps summary fields for sidebar", () => {
    const s = toApiSession({
      id: "abc",
      workspaceId: "w",
      title: "Hello",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-02T00:00:00.000Z",
    })
    expect(s.id).toBe("abc")
    expect(s.title).toBe("Hello")
    expect(s.directory).toBe("piws:w")
    expect(s.time.updated).toBeGreaterThan(0)
  })
})
