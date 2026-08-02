import assert from "node:assert/strict"
import test from "node:test"
import { statusForError } from "./http.ts"

test("maps bounded and unavailable backend capabilities to actionable HTTP statuses", () => {
  assert.equal(statusForError(Object.assign(new Error("too much output"), { code: "GIT_OUTPUT_LIMIT" })), 413)
  assert.equal(statusForError(Object.assign(new Error("no base"), { code: "GIT_BASE_NOT_FOUND" })), 409)
  assert.equal(statusForError(Object.assign(new Error("dialog closed"), { code: "EXTENSION_UI_CANCELLED" })), 409)
  assert.equal(statusForError(Object.assign(new Error("tui only"), { code: "EXTENSION_UI_TUI_ONLY" })), 501)
  assert.equal(statusForError(Object.assign(new Error("sdk mismatch"), { code: "PI_SDK_VERSION_MISMATCH" })), 503)
})
