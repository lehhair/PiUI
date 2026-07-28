import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PI_CAPABILITY_IDS } from "@piui/protocol"
import { createCapabilityManifestV2 } from "./protocol-v2.ts"

describe("Pi capability manifest", () => {
  it("describes every known capability and the extension RPC boundary", () => {
    const manifest = createCapabilityManifestV2("pi")
    assert.equal(manifest.revision, "pi-0.81.1-r18")
    assert.deepEqual(Object.keys(manifest.capabilities).sort(), [...PI_CAPABILITY_IDS].sort())
    assert.equal(manifest.capabilities["extension.commands"]?.limits?.sessionReplacementContext, true)
    assert.equal(manifest.capabilities["extension.commands"]?.limits?.shutdownContext, true)
    assert.equal(manifest.capabilities["extension.ui"]?.methods?.select?.support, "rpc")
    assert.equal(manifest.capabilities["extension.ui"]?.methods?.setToolsExpanded?.support, "web-equivalent")
    assert.equal(manifest.capabilities["extension.ui"]?.methods?.custom?.support, "tui-only")
    assert.equal(manifest.capabilities["files.write"]?.methods?.move?.support, "rpc")
    assert.equal(manifest.capabilities["files.search"]?.limits?.cancellable, true)
    assert.equal(manifest.capabilities["git.diff"]?.limits?.lazyFilePatch, true)
    assert.equal(manifest.capabilities["events.workspace"]?.enabled, true)
    assert.equal(manifest.capabilities["session.tree"]?.limits?.pagedBranch, true)
    assert.equal(manifest.capabilities["session.tree"]?.limits?.maxPageBytes, 33_554_432)
  })

  it("does not advertise native runtime features under the mock driver", () => {
    const capabilities = createCapabilityManifestV2("mock").capabilities
    assert.equal(capabilities["session.new"]?.enabled, false)
    assert.equal(capabilities["extension.ui"]?.enabled, false)
    assert.equal(capabilities["files.read"]?.enabled, true)
  })
})
