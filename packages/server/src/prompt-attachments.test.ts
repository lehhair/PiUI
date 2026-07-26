import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { preparePromptInput } from "./prompt-attachments.ts"

describe("preparePromptInput", () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-attachments-"))
  mkdirSync(path.join(root, "src"))
  writeFileSync(path.join(root, "src", "app.ts"), "export const app = true\n")
  after(() => rmSync(root, { recursive: true, force: true }))

  it("prepares native images and verified workspace references", () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64")
    const result = preparePromptInput(root, "Review these", [
      { type: "image", mimeType: "image/png", data: png, name: "screen.png" },
      { type: "file", path: "src/app.ts" },
      { type: "directory", path: "src" },
      { type: "text", name: "notes", text: "Keep the API stable" },
    ])

    assert.deepEqual(result.images, [{ type: "image", mimeType: "image/png", data: png }])
    assert.match(result.text, /Attached workspace file: src\/app\.ts/)
    assert.match(result.text, /Attached workspace directory: src/)
    assert.match(result.text, /Attached text: notes/)
  })

  it("rejects path escapes and mismatched image data", () => {
    assert.throws(
      () => preparePromptInput(root, "x", [{ type: "file", path: "../secret.txt" }]),
      /escapes workspace/,
    )
    const jpegBytes = Buffer.from("ffd8ff", "hex").toString("base64")
    assert.throws(
      () => preparePromptInput(root, "x", [{ type: "image", mimeType: "image/png", data: jpegBytes }]),
      /does not match/,
    )
  })

  it("allows an image-only prompt", () => {
    const data = Buffer.from("474946383961", "hex").toString("base64")
    assert.deepEqual(
      preparePromptInput(root, "", [{ type: "image", mimeType: "image/gif", data }]),
      { text: "", images: [{ type: "image", mimeType: "image/gif", data }] },
    )
  })
})
