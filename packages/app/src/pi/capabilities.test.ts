import { beforeEach, describe, expect, it } from "vitest"
import { getPiCapabilities, setPiCapabilities, setPiCapabilityManifest } from "./capabilities"

describe("Pi capability manifest", () => {
  beforeEach(() => setPiCapabilities(undefined))

  it("maps versioned native capabilities onto current UI gates", () => {
    setPiCapabilityManifest({
      protocolVersion: 2,
      revision: "test",
      capabilities: {
        "session.fork": { enabled: true, version: 1, scope: "session" },
        "files.write": { enabled: true, version: 1, scope: "workspace" },
        "git.diff": { enabled: true, version: 1, scope: "workspace" },
        "session.delete": { enabled: false, version: 1, scope: "session", reason: "not durable" },
      },
    })

    expect(getPiCapabilities()).toMatchObject({ fork: true, fileWrite: true, gitDiff: true })
    expect(getPiCapabilities().sessionRename).toBe(false)
  })
})
