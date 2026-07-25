/**
 * Temporary migration gate: registry SDK is absent and browser event routing
 * does not use CommonJS mode detection.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

describe("phase3 no opencode npm sdk", () => {
  it("package.json does not depend on registry @opencode-ai/sdk", () => {
    const pkg = JSON.parse(readFileSync(join(root, "packages/app/package.json"), "utf8"))
    const dep = pkg.dependencies?.["@opencode-ai/sdk"]
    assert.equal(dep, undefined, `unexpected dependency: ${dep}`)
    const dev = pkg.devDependencies?.["@opencode-ai/sdk"]
    assert.equal(dev, undefined)
  })

  it("does not use CommonJS require to decide the event transport", () => {
    const events = readFileSync(join(root, "packages/app/src/api/events.ts"), "utf8")
    assert.doesNotMatch(events, /require\(['"]\.\.\/pi\/serverMode/)
    assert.match(events, /if \(isPiUiBackendMode\(\)\) return \(\) => \{\}/)
  })

  it("does not create a real Pi session during application bootstrap", () => {
    const bootstrap = readFileSync(join(root, "packages/app/src/pi/bootstrapMockChat.ts"), "utf8")
    assert.doesNotMatch(bootstrap, /createPiSession/)
    assert.match(bootstrap, /seedMockChatIfEnabled/)
  })

  it("main does not auto-start opencode serve", () => {
    const main = readFileSync(join(root, "packages/app/src/main.tsx"), "utf8")
    assert.match(main, /opencode auto-start disabled|opencode auto-start/)
    // must not call initializeNativeDesktopService()
    assert.doesNotMatch(main, /void initializeNativeDesktopService\(\)/)
  })
})
