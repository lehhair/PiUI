/**
 * Temporary migration gate: registry SDK is absent and browser event routing
 * does not use CommonJS mode detection.
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
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

  it("production source has no OpenCode SDK import or local shim", () => {
    const sourceRoot = join(root, "packages/app/src")
    const files = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
      .map(entry => join(entry.parentPath, entry.name))
    for (const file of files) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /@opencode-ai\/sdk|createOpencodeClient|getSDKClient/)
    }
    assert.equal(existsSync(join(sourceRoot, "shims/opencode-sdk/v2/client.ts")), false)
    assert.equal(existsSync(join(sourceRoot, "api/sdk.ts")), false)
  })

  it("build config has no SDK alias", () => {
    const vite = readFileSync(join(root, "packages/app/vite.config.ts"), "utf8")
    const tsconfig = readFileSync(join(root, "packages/app/tsconfig.app.json"), "utf8")
    assert.doesNotMatch(vite, /opencode-ai\/sdk|sdkShim/)
    assert.doesNotMatch(tsconfig, /opencode-ai\/sdk|shims\/opencode-sdk/)
  })

  it("does not use CommonJS require to decide the event transport", () => {
    const events = readFileSync(join(root, "packages/app/src/api/events.ts"), "utf8")
    assert.doesNotMatch(events, /require\(['"]\.\.\/pi\/serverMode/)
    assert.doesNotMatch(events, /EventSource|\/global\/event|fetch\(/)
    assert.match(events, /PiUI has no OpenCode SSE transport/)
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

  it("server reaches the Pi SDK only through worker IPC", () => {
    const sourceRoot = join(root, "packages/server/src")
    const files = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
      .map(entry => join(entry.parentPath, entry.name))
    for (const file of files) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /@earendil-works\/pi-coding-agent|RealPiSession/)
    }
  })
})
