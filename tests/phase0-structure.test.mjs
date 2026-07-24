/**
 * Phase 0 structural gates — no network, no Pi model.
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

function mustExist(rel) {
  const p = join(root, rel)
  assert.ok(existsSync(p), `missing: ${rel}`)
  return p
}

function readJson(rel) {
  return JSON.parse(readFileSync(mustExist(rel), "utf8"))
}

describe("phase0 structure", () => {
  it("keeps design doc and baseline archive", () => {
    mustExist("docs/universal-agent-pi-technical-design.md")
    mustExist("_archive/opencodeui-baseline/src/App.tsx")
    mustExist("_archive/opencodeui-baseline/LICENSE")
  })

  it("has monorepo packages app / protocol / server", () => {
    const rootPkg = readJson("package.json")
    assert.deepEqual(rootPkg.workspaces, ["packages/*"])
    assert.equal(readJson("packages/app/package.json").name, "@piui/app")
    assert.equal(readJson("packages/protocol/package.json").name, "@piui/protocol")
    assert.equal(readJson("packages/server/package.json").name, "@piui/server")
  })

  it("app is a full OCUI shell (key UI entrypoints present)", () => {
    const keys = [
      "packages/app/src/App.tsx",
      "packages/app/src/main.tsx",
      "packages/app/src/features/chat/ChatArea.tsx",
      "packages/app/src/features/chat/ChatPane.tsx",
      "packages/app/src/features/chat/InputBox.tsx",
      "packages/app/src/features/message/MessageRenderer.tsx",
      "packages/app/src/components/FileExplorer.tsx",
      "packages/app/src/components/Terminal.tsx",
      "packages/app/src/index.css",
      "packages/app/LICENSE",
    ]
    for (const k of keys) mustExist(k)
  })

  it("server listens on loopback and does not call Pi models", () => {
    const index = readFileSync(mustExist("packages/server/src/index.ts"), "utf8")
    const http = readFileSync(mustExist("packages/server/src/http.ts"), "utf8")
    assert.match(index, /127\.0\.0\.1/)
    assert.match(http, /\/api\/v1\/health/)
    assert.doesNotMatch(index + http, /createAgentSession|pi-coding-agent/)
  })

  it("protocol exports version constant", () => {
    const src = readFileSync(mustExist("packages/protocol/src/index.ts"), "utf8")
    assert.match(src, /PROTOCOL_VERSION\s*=\s*1/)
  })

  it("wip archive captured previous half-built packages", () => {
    const archiveRoot = join(root, "_archive")
    const dirs = readdirSync(archiveRoot).filter(n => n.startsWith("wip-phase0-"))
    assert.ok(dirs.length >= 1, "expected _archive/wip-phase0-*")
    const wip = join(archiveRoot, dirs[0])
    assert.ok(statSync(wip).isDirectory())
  })

  it("root engines require Node >= 22.19", () => {
    const engines = readJson("package.json").engines?.node ?? ""
    assert.match(String(engines), /22/)
  })
})
