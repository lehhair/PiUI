import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parsePorcelainStatus } from "./git.ts"

describe("parsePorcelainStatus", () => {
  it("maps common codes", () => {
    const items = parsePorcelainStatus(
      [" M src/a.ts", "A  src/b.ts", " D src/c.ts", "?? new.txt"].join("\n"),
    )
    assert.equal(items.find(i => i.path === "src/a.ts")?.status, "modified")
    assert.equal(items.find(i => i.path === "src/b.ts")?.status, "added")
    assert.equal(items.find(i => i.path === "src/c.ts")?.status, "deleted")
    assert.equal(items.find(i => i.path === "new.txt")?.status, "added")
  })
})
