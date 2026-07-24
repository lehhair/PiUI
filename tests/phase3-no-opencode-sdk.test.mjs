/**
 * Phase 3 gate: no npm @opencode-ai/sdk dependency; production imports resolve to local shim.
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
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

  it("local shim exists", () => {
    assert.ok(existsSync(join(root, "packages/app/src/shims/opencode-sdk/v2/client.ts")))
  })

  it("vite aliases sdk to local shim", () => {
    const vite = readFileSync(join(root, "packages/app/vite.config.ts"), "utf8")
    assert.match(vite, /@opencode-ai\/sdk\/v2\/client/)
    assert.match(vite, /shims\/opencode-sdk/)
  })

  it("main does not auto-start opencode serve", () => {
    const main = readFileSync(join(root, "packages/app/src/main.tsx"), "utf8")
    assert.match(main, /opencode auto-start disabled|opencode auto-start/)
    // must not call initializeNativeDesktopService()
    assert.doesNotMatch(main, /void initializeNativeDesktopService\(\)/)
  })
})
