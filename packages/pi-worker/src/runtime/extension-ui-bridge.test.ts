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
    assert.equal(events.some(event => event.type === "settled" && event.reason === "timeout"), true)

    const controller = new AbortController()
    const input = bridge.context.input("Input", undefined, { signal: controller.signal })
    controller.abort()
    assert.equal(await input, undefined)
    assert.equal(events.some(event => event.type === "settled" && event.reason === "aborted"), true)
  })

  it("publishes state and keeps a synchronous editor mirror", () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => undefined)
    const events: PiExtensionUiEvent[] = []
    bridge.onEvent(event => events.push(event))
    bridge.context.setStatus("mode", "Planning")
    bridge.context.setWidget("plan", ["1. Inspect"], { placement: "aboveEditor" })
    bridge.context.setEditorText("hello")
    bridge.context.pasteToEditor(" world")
    bridge.context.setToolsExpanded(true)
    assert.equal(bridge.context.setTheme("dark").success, true)
    assert.equal(bridge.context.getEditorText(), "hello world")
    assert.equal(bridge.context.getToolsExpanded(), true)
    assert.equal(events.filter(event => event.type === "state").length, 4)
    assert.equal(events.filter(event => event.type === "editor").length, 2)
  })

  it("fails loudly for TUI-only APIs", () => {
    const themes = [{ name: "dark", path: "/themes/dark.json" }]
    const bridge = new ExtensionUiBridge(() => "session-1", () => undefined, () => themes)
    assert.throws(() => bridge.context.onTerminalInput(() => undefined), /unavailable/)
    assert.deepEqual(bridge.context.getAllThemes(), themes)
    assert.throws(() => bridge.context.getTheme("dark"), /unavailable/)
    assert.throws(() => bridge.context.getEditorComponent(), /unavailable/)
  })

  it("rejects malformed and oversized serializable UI values", () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => undefined)
    bridge.onEvent(() => undefined)
    assert.throws(() => bridge.context.setWidget("bad", ["ok", 1] as never), /at most 500 strings/)
    assert.throws(() => bridge.context.setTitle("x".repeat(4097)), /no longer than 4096/)
    assert.throws(
      () => bridge.context.select("many", Array.from({ length: 201 }, (_, index) => String(index))),
      /at most 200/,
    )
  })

  it("hosts component widgets offscreen and streams ANSI frames", async () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => "g1")
    const events: PiExtensionUiEvent[] = []
    bridge.onEvent(event => events.push(event))
    const { Container, Text } = await import("@earendil-works/pi-tui")

    bridge.context.setWidget("panel", (tui, theme) => {
      const container = new Container()
      container.addChild(new Text(theme.fg("accent", "hello panel"), 1, 0))
      return container
    }, { placement: "aboveEditor" })

    await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(events.some(event =>
      event.type === "tuiAttach" && event.attach.key === "panel" && event.attach.kind === "widget"))
    assert.ok(events.some(event => event.type === "tuiFrame" && event.data.includes("hello panel")))

    // clearing the widget unmounts the component and emits detach
    bridge.context.setWidget("panel", undefined)
    assert.ok(events.some(event => event.type === "tuiDetach" && event.key === "panel"))
  })

  it("runs custom() components offscreen and resolves through done()", async () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => "g1")
    const events: PiExtensionUiEvent[] = []
    bridge.onEvent(event => events.push(event))
    const { Container, Text } = await import("@earendil-works/pi-tui")

    const result = bridge.context.custom<number>((tui, theme, keybindings, done) => {
      const container = new Container()
      container.addChild(new Text("custom panel", 1, 0))
      setTimeout(() => done(42), 10)
      return container
    })

    await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(events.some(event => event.type === "tuiAttach" && event.attach.key === "custom" && event.attach.kind === "custom"))
    assert.equal(await result, 42)
    assert.ok(events.some(event => event.type === "tuiDetach" && event.key === "custom"))
  })
})
