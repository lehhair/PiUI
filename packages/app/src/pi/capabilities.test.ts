import { beforeEach, describe, expect, it } from "vitest"
import { getPiCapabilities } from "./capabilities"
import { piNativeStatusForTest } from "./nativeStatus"

describe("Pi capability registry", () => {
  beforeEach(() => piNativeStatusForTest(undefined))

  it("derives capabilities from registry commands natively", () => {
    piNativeStatusForTest({
      sessionCommands: [
        { name: "fork", scope: "session", source: "pi-sdk" },
        { name: "setSessionName", scope: "session", source: "pi-sdk" },
      ],
      globalCommands: [{ name: "session.delete", scope: "global", source: "pi-sdk" }],
    })

    const caps = getPiCapabilities()
    expect(caps.fork).toBe(true)
    expect(caps.sessionRename).toBe(true)
    expect(caps.sessionDelete).toBe(true)
    expect(caps.sessionTree).toBe(false)
    expect(caps.pty).toBe(false)
  })

  it("is unavailable without a registry", () => {
    expect(getPiCapabilities().fork).toBe(false)
    expect(getPiCapabilities().sessionDelete).toBe(false)
  })
})
