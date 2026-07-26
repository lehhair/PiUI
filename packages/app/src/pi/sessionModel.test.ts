import { describe, expect, it } from "vitest"
import { toUiSession } from "./sessionModel"

describe("toUiSession", () => {
  it("maps summary fields for sidebar", () => {
    const s = toUiSession({
      id: "abc",
      directory: "E:/work/project-a",
      title: "Hello",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-02T00:00:00.000Z",
    })
    expect(s.id).toBe("abc")
    expect(s.title).toBe("Hello")
    expect(s.directory).toBe("E:/work/project-a")
    expect(s.updatedAt).toBe(Date.parse("2020-01-02T00:00:00.000Z"))
  })

  it("uses stable timestamp fallbacks", () => {
    const s = toUiSession({
      id: "abc",
      directory: "/workspace",
      title: "Hello",
      createdAt: "invalid",
      updatedAt: "invalid",
    })
    expect(s.createdAt).toBe(0)
    expect(s.updatedAt).toBe(0)
  })

  it("uses the real directory returned with a session summary", () => {
    const s = toUiSession({
      id: "abc",
      directory: "E:/work/project-a",
      title: "Hello",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-02T00:00:00.000Z",
    })
    expect(s.directory).toBe("E:/work/project-a")
  })
})
