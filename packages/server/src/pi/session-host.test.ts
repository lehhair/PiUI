import assert from "node:assert/strict"
import test from "node:test"
import { EventHub } from "../event-hub.ts"
import type { WorkerSession } from "./worker-client.ts"
import type { RuntimeSupervisor } from "./supervisor.ts"
import { SessionHost } from "./session-host.ts"

test("SessionHost rejects reopening a runtime while it is closing", async () => {
  let releaseAbort!: () => void
  let opens = 0
  const worker = {
    command: async (type: string) => {
      if (type === "abort") return new Promise<void>(resolve => { releaseAbort = resolve })
      return {}
    },
    getSessionId: () => "session-1",
    getSessionFile: () => "session-1.jsonl",
    getCwd: () => ".",
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    open: async () => {
      opens += 1
      return worker
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())

  await host.openSession(".", "session-1.jsonl")
  const closing = host.closeSession("session-1")
  await assert.rejects(host.openSession(".", "session-1.jsonl"), { code: "RUNTIME_CLOSING" })

  releaseAbort()
  await closing
  await host.openSession(".", "session-1.jsonl")
  assert.equal(opens, 2)
})

test("SessionHost retries a busy self-heal attach", async () => {
  let opens = 0
  const worker = {
    command: async (type: string) => type === "tree.get" ? [{ id: "root" }] : {},
    getSessionId: () => "session-1",
    getSessionFile: () => "session-1.jsonl",
    getCwd: () => ".",
    onEvent: () => () => {},
    onCrash: () => () => {},
    onClose: () => () => {},
    dispose: async () => {},
  } as unknown as WorkerSession
  const supervisor = {
    onEvent: () => () => {},
    catalogCommand: async () => [{ id: "session-1", path: "session-1.jsonl", cwd: "." }],
    open: async () => {
      opens += 1
      if (opens === 1) throw Object.assign(new Error("lock is busy"), { code: "SESSION_BUSY" })
      return worker
    },
  } as unknown as RuntimeSupervisor
  const host = new SessionHost(supervisor, new EventHub())

  assert.deepEqual(await host.sessionQuery("session-1", "tree.get"), [{ id: "root" }])
  assert.equal(opens, 2)
  host.dispose()
})
