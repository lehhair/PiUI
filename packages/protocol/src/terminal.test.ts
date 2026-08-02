import assert from "node:assert/strict"
import test from "node:test"
import { TERMINAL_STREAM_PROTOCOL_VERSION, type TerminalStreamClientFrame, type TerminalStreamServerFrame } from "./terminal.ts"

test("terminal stream frames keep the cursor and protocol version explicit", () => {
  const input: TerminalStreamClientFrame = { type: "input", data: "\u0003" }
  const output: TerminalStreamServerFrame = {
    type: "output",
    cursor: 42,
    data: "ready\r\n",
  }

  assert.equal(input.type, "input")
  assert.equal(output.cursor, 42)
  assert.equal(TERMINAL_STREAM_PROTOCOL_VERSION, 1)
})
