import { beforeEach, describe, expect, it } from "vitest"
import { getPiCapabilities, setPiCapabilities, setPiRegistryCapabilities } from "./capabilities"

describe("Pi capability registry", () => {
  beforeEach(() => setPiCapabilities(undefined))

  it("keeps UI gates disabled until each native adapter is wired", () => {
    setPiRegistryCapabilities({
      protocolVersion: 1,
      revision: 1,
      sdkVersion: "test",
      driver: "mock",
      globalCommands: [],
      sessionCommands: [{
        name: "fork",
        scope: "session",
        source: "pi-sdk",
      }],
    })

    expect(getPiCapabilities().fork).toBe(false)
  })
})
