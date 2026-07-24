import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PROTOCOL_VERSION, DEFAULT_HOST_WS_URL } from "./index.ts"

describe("protocol v1 skeleton", () => {
  it("PROTOCOL_VERSION is 1", () => {
    assert.equal(PROTOCOL_VERSION, 1)
  })

  it("default host is loopback ws", () => {
    assert.equal(DEFAULT_HOST_WS_URL, "ws://127.0.0.1:8787")
  })
})
