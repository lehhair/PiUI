import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { createProjectionState, type PiSessionRuntime } from "@piui/pi-worker"
import { SessionRegistry, type PiSessionBackend } from "./session-registry.ts"
import { WorkspaceStore } from "./workspace-store.ts"

describe("native Pi session discovery", () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-native-session-"))
  after(() => rmSync(root, { recursive: true, force: true }))

  it("uses the Pi session id and opens only the server-discovered file", async () => {
    const projection = createProjectionState()
    const runtime = {
      getSessionId: () => "pi-native-id",
      getSessionFile: () => path.join(root, "native.jsonl"),
      getSessionName: () => "Native session",
      getProjection: () => projection,
    } as unknown as PiSessionRuntime
    const opened: Array<{ cwd: string; sessionFile?: string }> = []
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-native-id",
        path: path.join(root, "native.jsonl"),
        cwd: root,
        name: "Native session",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 2,
        firstMessage: "hello",
      }],
      open: async (cwd, sessionFile) => {
        opened.push({ cwd, sessionFile })
        return runtime
      },
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)

    const listed = await registry.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.id, "pi-native-id")
    assert.equal(listed[0]?.driverSessionId, "pi-native-id")
    assert.equal(listed[0]?.real, undefined)

    const attached = await registry.attach("pi-native-id")
    assert.equal(attached.real, runtime)
    assert.deepEqual(opened, [{ cwd: root, sessionFile: path.join(root, "native.jsonl") }])
  })

  it("deduplicates concurrent runtime attachment", async () => {
    const projection = createProjectionState()
    const runtime = {
      getSessionId: () => "pi-concurrent-id",
      getSessionFile: () => path.join(root, "concurrent.jsonl"),
      getSessionName: () => undefined,
      getProjection: () => projection,
    } as unknown as PiSessionRuntime
    let opens = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-concurrent-id",
        path: path.join(root, "concurrent.jsonl"),
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => {
        opens += 1
        await gate
        return runtime
      },
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)
    await registry.list()

    const first = registry.attach("pi-concurrent-id")
    const second = registry.attach("pi-concurrent-id")
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(opens, 1)
    release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.real, runtime)
    assert.equal(b.real, runtime)
  })
})
