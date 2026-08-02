import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  eventStreamKey,
  isJsonObject,
  parseEventStreamKey,
  problemFromError,
  requireJsonValue,
  toJsonValue,
  PROTOCOL_VERSION,
  PI_PARITY_SDK_VERSION,
  EVENT_WS_SUBPROTOCOL,
  CORE_COMMAND_TYPES,
  type CoreCommandParams,
} from "./index.js"

describe("protocol foundation", () => {
  it("pins versions", () => {
    assert.equal(PROTOCOL_VERSION, 1)
    assert.equal(PI_PARITY_SDK_VERSION, "0.81.1")
    assert.equal(EVENT_WS_SUBPROTOCOL, "piui.events.v1")
  })

  it("round-trips event stream keys", () => {
    assert.equal(eventStreamKey({ kind: "server", id: "server" }), "server")
    assert.equal(eventStreamKey({ kind: "session", id: "abc 123" }), `session:${encodeURIComponent("abc 123")}`)
    assert.deepEqual(parseEventStreamKey("server"), { kind: "server", id: "server" })
    assert.deepEqual(parseEventStreamKey(`session:${encodeURIComponent("abc 123")}`), { kind: "session", id: "abc 123" })
    assert.equal(parseEventStreamKey("bogus"), null)
    assert.equal(parseEventStreamKey(":nope"), null)
  })

  it("converts values to JSON structurally", () => {
    assert.deepEqual(toJsonValue({ a: [1, 2, { b: "c" }] }), { a: [1, 2, { b: "c" }] })
    assert.equal(toJsonValue(undefined), undefined)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    assert.equal(toJsonValue(circular), undefined)
    assert.throws(() => requireJsonValue(circular), /not JSON serializable/)
    assert.equal(isJsonObject({}), true)
    assert.equal(isJsonObject([]), false)
    assert.equal(isJsonObject(null), false)
  })

  it("maps errors to problems", () => {
    const withCode = problemFromError(Object.assign(new Error("boom"), { code: "SESSION_BUSY" }))
    assert.equal(withCode.code, "SESSION_BUSY")
    assert.equal(withCode.message, "boom")
    const fallback = problemFromError(new Error("plain"))
    assert.equal(fallback.code, "INTERNAL")
    const stringError = problemFromError("weird")
    assert.equal(stringError.message, "weird")
  })

  it("keeps the core command list free of duplicates", () => {
    assert.equal(new Set(CORE_COMMAND_TYPES).size, CORE_COMMAND_TYPES.length)
    assert.ok(CORE_COMMAND_TYPES.includes("invokeTool"))
    assert.ok(CORE_COMMAND_TYPES.includes("invokeCommand"))
    assert.ok(CORE_COMMAND_TYPES.includes("prompt"))
  })

  it("models the native prompt and user-message delivery options", () => {
    const prompt: CoreCommandParams["prompt"] = {
      text: "hello",
      streamingBehavior: "followUp",
    }
    const userMessage: CoreCommandParams["sendUserMessage"] = {
      text: "hello",
      deliverAs: "steer",
    }

    assert.equal(prompt.streamingBehavior, "followUp")
    assert.equal(userMessage.deliverAs, "steer")
  })
})
