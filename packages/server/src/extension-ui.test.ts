import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ExtensionUiDialogResponseV1 } from "@piui/protocol"
import { createProjectionState, type PiExtensionUiEvent, type PiSessionRuntime } from "@piui/pi-worker"
import { EventHub } from "./event-hub.ts"
import { SessionRegistry, type PiSessionBackend } from "./session-registry.ts"
import { WorkspaceStore } from "./workspace-store.ts"

describe("SessionRegistry extension UI", () => {
  it("exposes initialization dialogs and responds without waiting for initialization", async () => {
    const listeners = new Set<(event: PiExtensionUiEvent) => void>()
    let finishInitialization!: () => void
    let editorText = ""
    const initialization = new Promise<void>(resolve => { finishInitialization = resolve })
    const runtime = {
      getSessionId: () => "extension-session",
      getSessionFile: () => undefined,
      getSessionName: () => "Extension session",
      getWorkerGeneration: () => "generation-1",
      getProjection: () => createProjectionState(),
      getRuntimeUiState: () => ({
        phase: "idle",
        queue: { steering: [], followUp: [], steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
        retry: { phase: "idle", autoEnabled: true },
        compaction: { autoEnabled: true, operation: { type: "none" } },
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        activeTools: [],
        availableTools: [],
      }),
      getModel: () => undefined,
      getThinkingLevel: () => "off",
      getAvailableThinkingLevels: () => ["off"],
      isStreaming: () => false,
      getEntries: () => [],
      getTree: () => [],
      getLeafId: () => null,
      onState: () => () => {},
      onProjection: () => () => {},
      onProjectionDelta: () => () => {},
      onCrash: () => () => {},
      onExtensionUi: (listener: (event: PiExtensionUiEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      initializeExtensions: async () => {
        for (const listener of listeners) listener({
          type: "requested",
          request: {
            requestId: "request-1",
            sessionId: "extension-session",
            workerGeneration: "generation-1",
            kind: "select",
            title: "Mode",
            options: ["plan", "build"],
            createdAt: new Date().toISOString(),
          },
        })
        await initialization
      },
      respondExtensionUi: async (_requestId: string, response: ExtensionUiDialogResponseV1) => {
        assert.deepEqual(response, { value: "plan" })
        finishInitialization()
        return true
      },
      setExtensionEditorState: (text: string) => { editorText = text },
      dispose: async () => {},
    } as unknown as PiSessionRuntime
    const backend: PiSessionBackend = {
      listAll: async () => [],
      open: async () => runtime,
    }
    const workspaces = new WorkspaceStore()
    const workspace = workspaces.resolve(process.cwd())
    const registry = new SessionRegistry(workspaces, "pi", backend, new EventHub())

    const session = await registry.create(workspace.canonicalRoot)
    const pending = registry.extensionUiSnapshot(session.id)
    assert.equal(pending?.pending[0]?.title, "Mode")
    await registry.respondExtensionUi(session.id, "request-1", { value: "plan" }, "generation-1")
    assert.equal(registry.extensionUiSnapshot(session.id)?.pending.length, 0)

    await registry.setExtensionEditorState(session.id, "draft")
    assert.equal(editorText, "draft")
    assert.equal(registry.extensionUiSnapshot(session.id)?.state.editorText, "draft")
  })
})
