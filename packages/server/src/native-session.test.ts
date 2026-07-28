import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { nativeEntriesPage, nativeImageAttachment, nativeSessionHead, type PiSessionRuntime } from "@piui/pi-worker"
import { SessionRegistry, type PiSessionBackend } from "./session-registry.ts"
import { WorkspaceStore } from "./workspace-store.ts"
import { EventHub } from "./event-hub.ts"

function nativeEnvelope(leafId: string | null = null, text = "") {
  const entries = leafId ? [{
    id: leafId,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  }] : []
  return {
    namespace: "pi" as const,
    schemaVersion: 1 as const,
    sdkVersion: "0.81.1",
    revision: 1,
    header: null,
    leafId,
    entries,
    tree: leafId ? [{ entryId: leafId, children: [] }] : [],
  }
}

function nativeRuntime(native = nativeEnvelope()) {
  return {
    getNativeHead: () => nativeSessionHead(native),
    getNativeEntriesPage: (cursor: string | undefined, limit: number, maxBytes: number) =>
      nativeEntriesPage(native, { cursor, limit, maxBytes }),
    getNativeImageAttachment: (entryId: string, blockIndex: number) =>
      nativeImageAttachment(native, entryId, blockIndex),
  }
}

describe("native Pi session discovery", () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-native-session-"))
  after(() => rmSync(root, { recursive: true, force: true }))

  it("uses the Pi session id and opens only the server-discovered file", async () => {
    const runtime = {
      getSessionId: () => "pi-native-id",
      getSessionFile: () => path.join(root, "native.jsonl"),
      getSessionName: () => "Native session",
      ...nativeRuntime(),
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
    const runtime = {
      getSessionId: () => "pi-concurrent-id",
      getSessionFile: () => path.join(root, "concurrent.jsonl"),
      getSessionName: () => undefined,
      ...nativeRuntime(),
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

  it("keeps the source session and binds a replaced runtime to the fork target", async () => {
    let sessionId = "pi-fork-source"
    let sessionFile = path.join(root, "fork-source.jsonl")
    const runtime = {
      getWorkerGeneration: () => "fork-generation",
      onState: () => () => {},
      onCrash: () => () => {},
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getSessionName: () => "Forked session",
      getRuntimeUiState: () => ({
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        isStreaming: false,
        isCompacting: false,
        retryAttempt: 0,
        queue: { steering: [], followUp: [] },
        activeTools: [],
      }),
      getModel: () => undefined,
      getThinkingLevel: () => "off",
      getAvailableThinkingLevels: () => ["off"],
      isStreaming: () => false,
      getLeafId: () => sessionId === "pi-fork-source" ? "source-entry" : "target-entry",
      ...nativeRuntime(sessionId === "pi-fork-source"
        ? nativeEnvelope("source-entry", "source")
        : nativeEnvelope("target-entry", "target")),
      fork: async () => {
        const sourceSessionId = sessionId
        sessionId = "pi-fork-target"
        sessionFile = path.join(root, "fork-target.jsonl")
        return {
          sourceSessionId,
          targetSessionId: sessionId,
          targetSessionFile: sessionFile,
          targetCwd: root,
          cancelled: false,
        }
      },
      dispose: async () => {},
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-fork-source",
        path: path.join(root, "fork-source.jsonl"),
        cwd: root,
        name: "Source session",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "source",
      }],
      open: async () => runtime,
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)
    await registry.list()

    const result = await registry.forkSession("pi-fork-source", "source-entry", "at")
    assert.equal(result.source.id, "pi-fork-source")
    assert.equal(result.source.real, undefined)
    assert.equal(result.target.id, "pi-fork-target")
    assert.equal(result.target.real, runtime)
    assert.equal(registry.get("pi-fork-source"), result.source)
    assert.equal(registry.get("pi-fork-target"), result.target)
    const sourceSnapshot = registry.snapshot(result.source)
    assert.equal(sourceSnapshot.native.leafId, "source-entry")
    assert.equal(result.source.nativeHead?.leafId, "source-entry")
    assert.equal(result.source.nativeHead?.entryCount, 1)
  })

  it("detaches a source runtime after replacement lease commit failure", async () => {
    let disposals = 0
    const runtime = {
      getWorkerGeneration: () => "failed-replacement-generation",
      onState: () => () => {},
      onCrash: () => () => {},
      getSessionId: () => "pi-failed-replacement",
      getSessionFile: () => path.join(root, "failed-replacement.jsonl"),
      getSessionName: () => "Source",
      getLeafId: () => null,
      ...nativeRuntime(),
      fork: async () => {
        throw Object.assign(new Error("lease failed"), { code: "SESSION_REPLACEMENT_COMMIT_FAILED" })
      },
      dispose: async () => { disposals += 1 },
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-failed-replacement",
        path: path.join(root, "failed-replacement.jsonl"),
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "source",
      }],
      open: async () => runtime,
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)
    await registry.list()

    await assert.rejects(registry.forkSession("pi-failed-replacement", "source-entry", "at"), error => {
      assert.equal((error as { code?: string }).code, "SESSION_REPLACEMENT_COMMIT_FAILED")
      return true
    })
    assert.equal(registry.get("pi-failed-replacement")?.real, undefined)
    assert.equal(disposals, 1)
  })

  it("rejects a replacement that reuses the source JSONL", async () => {
    const sessionFile = path.join(root, "replacement-file-conflict.jsonl")
    let sessionId = "pi-file-conflict-source"
    let disposals = 0
    const runtime = {
      getWorkerGeneration: () => "file-conflict-generation",
      onState: () => () => {},
      onCrash: () => () => {},
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getSessionName: () => "Source",
      getLeafId: () => null,
      ...nativeRuntime(),
      fork: async () => {
        const sourceSessionId = sessionId
        sessionId = "pi-file-conflict-target"
        return {
          sourceSessionId,
          targetSessionId: sessionId,
          targetSessionFile: sessionFile,
          targetCwd: root,
          cancelled: false,
        }
      },
      dispose: async () => { disposals += 1 },
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-file-conflict-source",
        path: sessionFile,
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "source",
      }],
      open: async () => runtime,
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)
    await registry.list()

    await assert.rejects(registry.forkSession("pi-file-conflict-source", "source-entry", "at"), error => {
      assert.equal((error as { code?: string }).code, "SESSION_REPLACEMENT_FILE_CONFLICT")
      return true
    })
    assert.equal(registry.get("pi-file-conflict-source")?.real, undefined)
    assert.equal(registry.get("pi-file-conflict-target"), undefined)
    assert.equal(disposals, 1)
  })

  it("deletes a persisted JSONL only after disposing its runtime", async () => {
    const sessionFile = path.join(root, "durable-delete.jsonl")
    writeFileSync(sessionFile, "{}\n")
    let disposed = false
    const runtime = {
      getSessionId: () => "pi-durable-delete",
      getSessionFile: () => sessionFile,
      getSessionName: () => "Delete me",
      ...nativeRuntime(),
      onState: () => () => {},
      onCrash: () => () => {},
      dispose: async () => { disposed = true },
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-durable-delete",
        path: sessionFile,
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => runtime,
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)
    await registry.list()
    await registry.attach("pi-durable-delete")

    assert.equal(await registry.delete("pi-durable-delete"), true)
    assert.equal(disposed, true)
    assert.equal(existsSync(sessionFile), false)
  })

  it("restores a detached registry record when durable unlink fails", async () => {
    const sessionFile = path.join(root, "not-a-jsonl-file")
    mkdirSync(sessionFile)
    let disposed = false
    const runtime = {
      getSessionId: () => "pi-delete-failure",
      getSessionFile: () => sessionFile,
      getSessionName: () => "Keep me",
      ...nativeRuntime(),
      onState: () => () => {},
      onCrash: () => () => {},
      dispose: async () => { disposed = true },
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-delete-failure",
        path: sessionFile,
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => runtime,
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)
    await registry.list()
    await registry.attach("pi-delete-failure")

    await assert.rejects(registry.delete("pi-delete-failure"))
    assert.equal(disposed, true)
    assert.ok(registry.get("pi-delete-failure"))
    assert.equal(registry.get("pi-delete-failure")?.real, undefined)
  })

  it("disposes a runtime that finishes opening after its session was deleted", async () => {
    let disposals = 0
    const runtime = {
      getSessionId: () => "pi-delete-during-open",
      getSessionFile: () => path.join(root, "delete-during-open.jsonl"),
      getSessionName: () => undefined,
      dispose: async () => { disposals += 1 },
    } as unknown as PiSessionRuntime
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-delete-during-open",
        path: path.join(root, "delete-during-open.jsonl"),
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => {
        await gate
        return runtime
      },
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)
    await registry.list()
    const attaching = registry.attach("pi-delete-during-open")
    void attaching.catch(() => undefined)
    await new Promise<void>(resolve => setImmediate(resolve))
    const deleting = registry.delete("pi-delete-during-open")
    release()

    assert.equal(await deleting, true)
    await assert.rejects(attaching, error => {
      assert.equal((error as { code?: string }).code, "SESSION_NOT_FOUND")
      return true
    })
    assert.equal(disposals, 1)
    assert.equal(registry.get("pi-delete-during-open"), undefined)
  })

  it("deduplicates concurrent and recent discovery scans", async () => {
    let scans = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const backend: PiSessionBackend = {
      listAll: async () => {
        scans += 1
        await gate
        return []
      },
      open: async () => { throw new Error("not used") },
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)

    const first = registry.list()
    const second = registry.list()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(scans, 1)
    release()
    await Promise.all([first, second])
    await registry.list()
    assert.equal(scans, 1)
  })

  it("uses Pi scoped listing when a workspace is known", async () => {
    const workspaces = new WorkspaceStore()
    const workspace = workspaces.resolve(root)
    let scopedCwd: string | undefined
    const backend: PiSessionBackend = {
      list: async cwd => {
        scopedCwd = cwd
        return []
      },
      listAll: async () => { throw new Error("global scan should not run") },
      open: async () => { throw new Error("not used") },
    }
    const registry = new SessionRegistry(workspaces, "pi", backend)

    await registry.list(workspace.canonicalRoot)
    assert.equal(scopedCwd, workspace.canonicalRoot)
  })

  it("records worker generation and publishes runtime replacement and crash", async () => {
    let crash: ((error: Error) => void) | undefined
    const runtime = {
      getWorkerGeneration: () => "worker-generation-1",
      onCrash: (listener: (error: Error) => void) => {
        crash = listener
        return () => { crash = undefined }
      },
      getSessionId: () => "pi-lifecycle-id",
      getSessionFile: () => path.join(root, "lifecycle.jsonl"),
      getSessionName: () => "Lifecycle session",
      getRuntimeUiState: () => ({
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        isStreaming: false,
        isCompacting: false,
        retryAttempt: 0,
        queue: { steering: [], followUp: [] },
        activeTools: [],
      }),
      getModel: () => undefined,
      getThinkingLevel: () => "off",
      getAvailableThinkingLevels: () => ["off"],
      isStreaming: () => false,
      getLeafId: () => null,
      ...nativeRuntime(nativeEnvelope("crash-entry", "preserve after crash")),
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-lifecycle-id",
        path: path.join(root, "lifecycle.jsonl"),
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => runtime,
    }
    const eventHub = new EventHub()
    const eventTypes: string[] = []
    eventHub.subscribeV2(event => eventTypes.push(event.type))
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend, eventHub)
    await registry.list()

    const attached = await registry.attach("pi-lifecycle-id")
    assert.equal(registry.snapshot(attached).runtime.workerGeneration, "worker-generation-1")
    assert.deepEqual(eventTypes, ["session.runtime.replaced", "session.snapshot.updated"])

    assert.ok(crash)
    crash(new Error("worker stopped"))
    assert.equal(registry.snapshot(attached).session.state, "crashed")
    assert.equal(registry.snapshot(attached).runtime.runtimeError, "worker stopped")
    assert.equal(registry.snapshot(attached).runtime.isStreaming, false)
    assert.equal(attached.real, undefined)
    assert.equal(attached.nativeHead?.leafId, "crash-entry")
    assert.deepEqual(eventTypes, [
      "session.runtime.replaced",
      "session.snapshot.updated",
      "session.runtime.crashed",
      "session.snapshot.updated",
    ])
  })

  it("detaches a runtime after an extension requests graceful shutdown", async () => {
    let close: (() => void) | undefined
    const runtime = {
      getWorkerGeneration: () => "graceful-generation",
      onClose: (listener: () => void) => {
        close = listener
        return () => { close = undefined }
      },
      getSessionId: () => "pi-graceful-id",
      getSessionFile: () => path.join(root, "graceful.jsonl"),
      getSessionName: () => "Graceful session",
      getRuntimeUiState: () => ({
        thinkingLevel: "off", availableThinkingLevels: ["off"], isStreaming: false,
        isCompacting: false, retryAttempt: 0, queue: { steering: [], followUp: [] }, activeTools: [],
      }),
      getModel: () => undefined,
      getThinkingLevel: () => "off",
      getAvailableThinkingLevels: () => ["off"],
      isStreaming: () => false,
      getLeafId: () => null,
      ...nativeRuntime(),
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-graceful-id",
        path: path.join(root, "graceful.jsonl"),
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => runtime,
    }
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend)
    await registry.list()
    const session = await registry.attach("pi-graceful-id")
    assert.ok(close)
    close()
    assert.equal(session.real, undefined)
    assert.equal(session.workerGeneration, undefined)
    assert.equal(registry.snapshot(session).runtime.attached, false)
  })

  it("moves a runtime when an extension replaces its session during a prompt", async () => {
    const sourceId = "pi-extension-source"
    const targetId = "pi-extension-target"
    const sourceFile = path.join(root, "extension-source.jsonl")
    const targetFile = path.join(root, "extension-target.jsonl")
    let currentId = sourceId
    let currentFile = sourceFile
    let onReplacement: ((replacement: import("@piui/protocol").SessionReplacementResultV1) => Promise<void>) | undefined
    let onNativeEvent: ((event: import("@piui/protocol").PiNativeJsonValueV1, meta: import("@piui/protocol").PiNativeEventMetaV1) => void) | undefined
    const runtime = {
      getWorkerGeneration: () => "extension-replacement-generation",
      getSessionId: () => currentId,
      getSessionFile: () => currentFile,
      getSessionName: () => "Extension target",
      getRuntimeUiState: () => ({
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        isStreaming: false,
        isCompacting: false,
        isIdle: true,
        isBashRunning: false,
        hasPendingBashMessages: false,
        isRetrying: false,
        retryAttempt: 0,
        pendingMessageCount: 0,
        queue: { steering: [], followUp: [], steeringMode: "all", followUpMode: "all" },
        retry: { phase: "idle", autoEnabled: true },
        compaction: { autoEnabled: true, operation: { type: "none" } },
        tools: [],
        activeTools: [],
        supportsThinking: false,
        scopedModels: [],
      }),
      getModel: () => undefined,
      getThinkingLevel: () => "off",
      getAvailableThinkingLevels: () => ["off"],
      isStreaming: () => false,
      getLeafId: () => null,
      ...nativeRuntime(),
      onSessionReplacement: (listener: typeof onReplacement) => {
        onReplacement = listener
        return () => { onReplacement = undefined }
      },
      onNativeEvent: (listener: typeof onNativeEvent) => {
        onNativeEvent = listener
        return () => { onNativeEvent = undefined }
      },
      prompt: async () => {
        currentId = targetId
        currentFile = targetFile
        onNativeEvent?.(
          { type: "message_start", message: { role: "user", content: "target message" } },
          {
            position: { epoch: "target-events", sequence: 1 },
            liveMessage: { id: "target-live", revision: 1 },
          },
        )
        await onReplacement?.({
          operation: "new",
          sourceSessionId: sourceId,
          targetSessionId: targetId,
          targetSessionFile: targetFile,
          targetCwd: root,
          cancelled: false,
        })
      },
      dispose: async () => {},
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: sourceId,
        path: sourceFile,
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "extension command",
      }],
      open: async () => runtime,
    }
    const eventHub = new EventHub()
    const nativeEventStreams: string[] = []
    eventHub.subscribeV2(event => {
      if (event.type === "session.native.event") nativeEventStreams.push(event.stream.id)
    })
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend, eventHub)
    await registry.list()
    await registry.attach(sourceId)

    const target = await registry.prompt(sourceId, "/new-from-extension")
    assert.equal(target.id, targetId)
    assert.equal(target.real, runtime)
    assert.equal(target.sessionFile, targetFile)
    assert.equal(registry.get(sourceId)?.real, undefined)
    assert.equal(registry.get(targetId)?.real, runtime)
    assert.deepEqual(nativeEventStreams, [])
  })

  it("rejects delayed callbacks from a crashed worker generation", async () => {
    let crashFirst!: (error: Error) => void
    let staleTick: (() => void) | undefined
    let releasePrompt!: () => void
    const promptGate = new Promise<void>(resolve => { releasePrompt = resolve })
    let secondState!: () => void
    const runtimeState = {
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      isStreaming: false,
      isCompacting: false,
      retryAttempt: 0,
      queue: { steering: [], followUp: [] },
      activeTools: [],
    }
    const common = {
      getSessionId: () => "pi-generation-id",
      getSessionFile: () => path.join(root, "generation.jsonl"),
      getSessionName: () => "Generation session",
      getRuntimeUiState: () => runtimeState,
      getModel: () => undefined,
      getThinkingLevel: () => "off",
      getAvailableThinkingLevels: () => ["off"],
      isStreaming: () => false,
      getLeafId: () => null,
      ...nativeRuntime(),
      dispose: async () => {},
    }
    const first = {
      ...common,
      getWorkerGeneration: () => "generation-1",
      onState: (listener: () => void) => {
        staleTick = listener
        return () => {}
      },
      onCrash: (listener: (error: Error) => void) => {
        crashFirst = listener
        return () => {}
      },
      prompt: async () => { await promptGate },
    } as unknown as PiSessionRuntime
    const second = {
      ...common,
      getWorkerGeneration: () => "generation-2",
      onState: (listener: () => void) => {
        listener()
        secondState = listener
        return () => {}
      },
      onCrash: () => () => {},
    } as unknown as PiSessionRuntime
    let opens = 0
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "pi-generation-id",
        path: path.join(root, "generation.jsonl"),
        cwd: root,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => (++opens === 1 ? first : second),
    }
    const runtimeCrashes: string[] = []
    const registry = new SessionRegistry(
      new WorkspaceStore(),
      "pi",
      backend,
      new EventHub(),
      (_sessionId, generation) => runtimeCrashes.push(generation ?? ""),
    )
    await registry.list()
    const running = registry.prompt("pi-generation-id", "hello")
    await new Promise<void>(resolve => setImmediate(resolve))

    crashFirst(new Error("generation 1 crashed"))
    const replacement = await registry.attach("pi-generation-id")
    assert.equal(replacement.workerGeneration, "generation-2")
    const replacementSequence = replacement.sequence
    staleTick?.()
    releasePrompt()
    await assert.rejects(running, error => {
      assert.equal((error as { code?: string }).code, "SESSION_RUNTIME_CRASHED")
      return true
    })
    assert.equal(replacement.real, second)
    assert.equal(replacement.sequence, replacementSequence)
    assert.deepEqual(runtimeCrashes, ["generation-1"])

    secondState()
    assert.equal(replacement.sequence, replacementSequence + 1)
  })

  it("coalesces resource events across attached sessions and reports trust detachment", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-resources-"))
    const resourceListeners: Array<() => void> = []
    const makeRuntime = (id: string): PiSessionRuntime => ({
      getSessionId: () => id,
      getSessionFile: () => path.join(cwd, `${id}.jsonl`),
      getSessionName: () => id,
      getLeafId: () => undefined,
      ...nativeRuntime(),
      getRuntimeUiState: () => undefined,
      getModel: () => undefined,
      getThinkingLevel: () => "medium",
      getAvailableThinkingLevels: () => ["off", "medium"],
      isStreaming: () => false,
      // Every runtime reload notifies the registry, which is the source of the
      // duplicate events this test pins down.
      onResourcesChanged: (listener: () => void) => {
        resourceListeners.push(listener)
        return () => undefined
      },
      reload: async () => { for (const listener of resourceListeners) listener() },
      dispose: async () => undefined,
    } as unknown as PiSessionRuntime)

    const sessionIds = ["res-a", "res-b", "res-c"]
    const runtimes = new Map(sessionIds.map(id => [id, makeRuntime(id)]))
    const backend: PiSessionBackend = {
      listAll: async () => sessionIds.map(id => ({
        id,
        path: path.join(cwd, `${id}.jsonl`),
        cwd,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      })),
      open: async (_cwd, sessionFile) => {
        const id = path.basename(String(sessionFile), ".jsonl")
        return runtimes.get(id)!
      },
      patchSettings: async () => ({
        workspacePath: cwd,
        projectTrusted: true,
        global: {},
        project: {},
        effective: {} as never,
        errors: [],
      }),
      setProjectTrust: async () => ({
        workspacePath: cwd,
        required: true,
        decision: true,
        defaultDecision: "ask" as const,
        trusted: true,
      }),
    }
    const hub = new EventHub()
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend, hub)
    const events: Array<{ type: string; revision?: string }> = []
    hub.subscribeV2(event => {
      if (event.type === "resources.updated") {
        events.push({ type: event.type, revision: (event.payload as { revision: string }).revision })
      } else if (event.type === "workspace.sessions.updated" || event.type === "session.snapshot.updated") {
        events.push({ type: event.type })
      }
    })

    const listed = await registry.list()
    const workspacePath = listed[0]!.cwd
    for (const id of sessionIds) await registry.attach(id)

    events.length = 0
    await registry.patchSettings(workspacePath, { quietStartup: true })
    const resourceEvents = events.filter(event => event.type === "resources.updated")
    assert.equal(resourceEvents.length, 1, `expected one coalesced event, got ${resourceEvents.length}`)
    assert.equal(new Set(resourceEvents.map(event => event.revision)).size, 1)

    events.length = 0
    await registry.setProjectTrust(workspacePath, true)
    // Trust changes detach every runtime, so clients must be told.
    assert.equal(events.filter(event => event.type === "session.snapshot.updated").length, sessionIds.length)
    assert.equal(events.some(event => event.type === "workspace.sessions.updated"), true)
    for (const id of sessionIds) assert.equal((await registry.find(id))?.real, undefined)

    rmSync(cwd, { recursive: true, force: true })
  })

  it("reclaims idle runtimes but never one with work in flight", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-idle-"))
    const idleState = {
      thinkingLevel: "medium",
      availableThinkingLevels: ["off", "medium"],
      isStreaming: false,
      isCompacting: false,
      isIdle: true,
      isBashRunning: false,
      hasPendingBashMessages: false,
      isRetrying: false,
      retryAttempt: 0,
      pendingMessageCount: 0,
      queue: { steering: [], followUp: [], steeringMode: "all", followUpMode: "all" },
      retry: { phase: "idle", autoEnabled: false },
    }
    let uiState: Record<string, unknown> = { ...idleState }
    let disposals = 0
    let opens = 0
    const makeRuntime = (id: string) => ({
      getSessionId: () => id,
      getSessionFile: () => path.join(cwd, `${id}.jsonl`),
      getSessionName: () => id,
      getLeafId: () => undefined,
      getRuntimeUiState: () => uiState,
      getModel: () => undefined,
      getThinkingLevel: () => "medium",
      getAvailableThinkingLevels: () => ["off", "medium"],
      isStreaming: () => false,
      ...nativeRuntime(nativeEnvelope("idle-entry", "preserve after detach")),
      dispose: async () => { disposals += 1 },
    }) as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "idle-session",
        path: path.join(cwd, "idle-session.jsonl"),
        cwd,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => { opens += 1; return makeRuntime("idle-session") },
    }
    const hub = new EventHub()
    const registry = new SessionRegistry(
      new WorkspaceStore(), "pi", backend, hub, undefined,
      // Disable the timer; the test drives the sweep directly.
      { idleRuntimeTimeoutMs: 1000, idleSweepIntervalMs: 0 },
    )
    await registry.list()
    await registry.attach("idle-session")
    assert.equal((await registry.find("idle-session"))?.real !== undefined, true)

    // Recently used, so it stays.
    assert.deepEqual(await registry.reclaimIdleRuntimes(), [])

    const future = Date.now() + 5000
    // Each of these means work is still in flight and must block reclamation.
    for (const busy of [
      { isStreaming: true },
      { isCompacting: true },
      { isBashRunning: true },
      { hasPendingBashMessages: true },
      { isRetrying: true },
      { retry: { phase: "waiting", autoEnabled: true } },
      { pendingMessageCount: 2 },
      { queue: { steering: ["queued"], followUp: [], steeringMode: "all", followUpMode: "all" } },
    ]) {
      uiState = { ...idleState, ...busy }
      assert.deepEqual(
        await registry.reclaimIdleRuntimes(future),
        [],
        `a session with ${Object.keys(busy)[0]} must not be reclaimed`,
      )
    }

    const events: string[] = []
    hub.subscribeV2(event => {
      if (event.type === "session.snapshot.updated") events.push(event.payload.sessionId)
    })
    uiState = { ...idleState }
    assert.deepEqual(await registry.reclaimIdleRuntimes(future), ["idle-session"])
    assert.equal(disposals, 1)
    assert.deepEqual(events, ["idle-session"], "clients must learn the runtime detached")

    // The session record survives, so using it again simply reopens it.
    const session = await registry.find("idle-session")
    assert.equal(session?.real, undefined)
    assert.equal(session?.nativeHead?.leafId, "idle-entry")
    await registry.attach("idle-session")
    assert.equal((await registry.find("idle-session"))?.real !== undefined, true)
    assert.equal(opens, 2)

    await registry.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })

  it("reports every credential change on the provider stream", async () => {
    const backend: PiSessionBackend = {
      listAll: async () => [],
      open: async () => { throw new Error("not used") },
      setRuntimeApiKey: async () => undefined,
      removeRuntimeApiKey: async () => undefined,
      logoutProvider: async () => undefined,
    }
    const hub = new EventHub()
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend, hub)
    const updates: Array<{ providerId: string; authenticated: boolean; stream: string }> = []
    hub.subscribeV2(event => {
      if (event.type === "provider.auth.updated") {
        updates.push({
          providerId: event.payload.providerId,
          authenticated: event.payload.authenticated,
          stream: `${event.stream.kind}:${event.stream.id}`,
        })
      }
    })

    // Without these the UI cannot tell a provider became usable without polling.
    await registry.setRuntimeApiKey("anthropic", "secret")
    await registry.removeRuntimeApiKey("anthropic")
    await registry.logoutProvider("anthropic")

    assert.deepEqual(updates, [
      { providerId: "anthropic", authenticated: true, stream: "provider:anthropic" },
      { providerId: "anthropic", authenticated: false, stream: "provider:anthropic" },
      { providerId: "anthropic", authenticated: false, stream: "provider:anthropic" },
    ])
  })

  it("scopes session credential changes to that session's stream", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "piui-session-auth-"))
    const runtime = {
      getSessionId: () => "auth-session",
      getSessionFile: () => path.join(cwd, "auth-session.jsonl"),
      getSessionName: () => "auth",
      getLeafId: () => undefined,
      ...nativeRuntime(),
      getRuntimeUiState: () => undefined,
      getModel: () => undefined,
      getThinkingLevel: () => "medium",
      getAvailableThinkingLevels: () => ["off", "medium"],
      isStreaming: () => false,
      setSessionRuntimeApiKey: async () => undefined,
      logoutRuntimeProvider: async () => undefined,
      dispose: async () => undefined,
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [{
        id: "auth-session",
        path: path.join(cwd, "auth-session.jsonl"),
        cwd,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
      open: async () => runtime,
    }
    const hub = new EventHub()
    const registry = new SessionRegistry(new WorkspaceStore(), "pi", backend, hub)
    await registry.list()

    const updates: Array<{ authenticated: boolean; sessionId?: string; stream: string }> = []
    hub.subscribeV2(event => {
      if (event.type === "provider.auth.updated") {
        updates.push({
          authenticated: event.payload.authenticated,
          sessionId: event.payload.sessionId,
          stream: `${event.stream.kind}:${event.stream.id}`,
        })
      }
    })

    await registry.setSessionRuntimeApiKey("auth-session", "anthropic", "secret")
    await registry.logoutSessionProvider("auth-session", "anthropic")

    // A session-scoped credential only affects that runtime, so a client
    // watching the global provider stream must not be told otherwise.
    assert.deepEqual(updates, [
      { authenticated: true, sessionId: "auth-session", stream: "session:auth-session" },
      { authenticated: false, sessionId: "auth-session", stream: "session:auth-session" },
    ])

    rmSync(cwd, { recursive: true, force: true })
  })

  it("keeps package progress attached to the workspace that asked for it", async () => {
    const firstRoot = mkdtempSync(path.join(tmpdir(), "piui-pkg-a-"))
    const secondRoot = mkdtempSync(path.join(tmpdir(), "piui-pkg-b-"))
    let emit: ((event: { commandId: string; type: "start"; action: "install"; source: string }) => void) | undefined
    const started: string[] = []
    const backend: PiSessionBackend = {
      listAll: async () => [],
      open: async () => { throw new Error("not used") },
      onPackageProgress: listener => {
        emit = listener as typeof emit
        return () => undefined
      },
      managePackage: async (_cwd, commandId) => {
        started.push(commandId)
        emit?.({ commandId, type: "start", action: "install", source: "./pkg" })
        return []
      },
    }
    const hub = new EventHub()
    const workspaces = new WorkspaceStore()
    const registry = new SessionRegistry(workspaces, "pi", backend, hub)
    const progress: Array<{ commandId: string; workspacePath?: string }> = []
    const resourceRevisions: string[] = []
    hub.subscribeV2(event => {
      if (event.type === "packages.progress") {
        progress.push(event.payload as { commandId: string; workspacePath?: string })
      } else if (event.type === "resources.updated") {
        resourceRevisions.push(event.payload.revision)
      }
    })

    const first = workspaces.resolve(firstRoot).canonicalRoot
    const second = workspaces.resolve(secondRoot).canonicalRoot
    // Clients pick their own command ids, so two workspaces can collide.
    await registry.managePackage(first, "shared-id", "install", "./pkg")
    await registry.managePackage(second, "shared-id", "install", "./pkg")

    assert.equal(new Set(started).size, 2, "the worker must see distinct progress ids")
    assert.deepEqual(progress.map(item => item.workspacePath), [first, second])
    // The client still gets back the id it submitted.
    assert.deepEqual(progress.map(item => item.commandId), ["shared-id", "shared-id"])
    assert.deepEqual(resourceRevisions, ["shared-id", "shared-id"])

    rmSync(firstRoot, { recursive: true, force: true })
    rmSync(secondRoot, { recursive: true, force: true })
  })
})
