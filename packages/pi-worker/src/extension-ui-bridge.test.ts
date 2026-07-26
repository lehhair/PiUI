import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ExtensionUiBridge, type PiExtensionUiEvent } from "./extension-ui-bridge.ts"

describe("ExtensionUiBridge", () => {
  it("round-trips blocking dialog responses", async () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => "generation-1")
    let requestId = ""
    bridge.onEvent(event => {
      if (event.type === "requested") requestId = event.request.requestId
    })
    const selected = bridge.context.select("Choose", ["a", "b"])
    assert.ok(requestId)
    assert.equal(bridge.respond(requestId, { value: "b" }), true)
    assert.equal(await selected, "b")
    assert.equal(bridge.respond(requestId, { value: "a" }), false)
  })

  it("cancels timed out and aborted dialogs", async () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => undefined)
    const events: PiExtensionUiEvent[] = []
    bridge.onEvent(event => events.push(event))
    assert.equal(await bridge.context.confirm("Confirm", "Continue?", { timeout: 5 }), false)
    assert.equal(events.some(event => event.type === "cancelled" && event.reason === "timeout"), true)

    const controller = new AbortController()
    const input = bridge.context.input("Input", undefined, { signal: controller.signal })
    controller.abort()
    assert.equal(await input, undefined)
    assert.equal(events.some(event => event.type === "cancelled" && event.reason === "aborted"), true)
  })

  it("publishes state and keeps a synchronous editor mirror", () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => undefined)
    const events: PiExtensionUiEvent[] = []
    bridge.onEvent(event => events.push(event))
    bridge.context.setStatus("mode", "Planning")
    bridge.context.setWidget("plan", ["1. Inspect"], { placement: "aboveEditor" })
    bridge.context.setEditorText("hello")
    bridge.context.pasteToEditor(" world")
    assert.equal(bridge.context.getEditorText(), "hello world")
    assert.equal(events.filter(event => event.type === "state").length, 2)
    assert.equal(events.filter(event => event.type === "editor").length, 2)
  })
})
