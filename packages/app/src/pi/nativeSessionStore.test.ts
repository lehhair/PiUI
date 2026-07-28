import type { PiNativeEntriesPageV1, PiNativeEventMetaV1, SessionSnapshotV1 } from "@piui/protocol"
import { beforeEach, describe, expect, it } from "vitest"
import { nativeSessionStore } from "./nativeSessionStore"

function snapshot(id = "s1", sequence = 1, leafId: string | null = "a-main"): SessionSnapshotV1 {
  return {
    protocolVersion: 1,
    epoch: "snapshot-epoch",
    sequence,
    session: {
      id,
      directory: "/workspace",
      driverId: "pi",
      driverSessionId: id,
      state: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    runtime: {
      attached: true,
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      isStreaming: false,
      isCompacting: false,
      queue: { steering: [], followUp: [], steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
      retry: { phase: "idle", autoEnabled: false },
      compaction: { autoEnabled: false, operation: { type: "none" } },
      tools: [],
      activeTools: [],
    },
    native: {
      namespace: "pi",
      schemaVersion: 1,
      sdkVersion: "0.81.1",
      revision: sequence,
      epoch: "native-epoch",
      header: null,
      leafId,
      entryCount: 4,
    },
  } as unknown as SessionSnapshotV1
}

function page(items: PiNativeEntriesPageV1["items"], hasMore = false, beforeCursor?: string): PiNativeEntriesPageV1 {
  return {
    head: snapshot().native,
    items,
    checkpoint: { position: { epoch: "worker-epoch", sequence: 0 } },
    hasMore,
    beforeCursor,
  }
}

function meta(sequence: number, id = "live-1", revision = sequence): PiNativeEventMetaV1 {
  return {
    position: { epoch: "worker-epoch", sequence },
    liveMessage: { id, revision },
  }
}

describe("nativeSessionStore", () => {
  beforeEach(() => nativeSessionStore.clear())

  it("walks only the loaded ancestors of the active leaf and excludes side branches", () => {
    nativeSessionStore.replace(snapshot())
    nativeSessionStore.replaceFirstPage("s1", page([
      { type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } },
      { type: "message", id: "a-side", parentId: "u-root", message: { role: "assistant", content: "side" } },
      { type: "message", id: "u-main", parentId: "u-root", message: { role: "user", content: "main" } },
      { type: "message", id: "a-main", parentId: "u-main", message: { role: "assistant", content: "answer" } },
    ]))

    expect(nativeSessionStore.getActiveBranch("s1").map(entry => entry.id)).toEqual(["u-root", "u-main", "a-main"])
  })

  it("caches older raw entries and rebuilds the full loaded branch", () => {
    nativeSessionStore.replace(snapshot())
    nativeSessionStore.replaceFirstPage("s1", page([
      { type: "message", id: "u-main", parentId: "u-root", message: { role: "user", content: "main" } },
      { type: "message", id: "a-main", parentId: "u-main", message: { role: "assistant", content: "answer" } },
    ], true, "older"))
    expect(nativeSessionStore.getActiveBranch("s1").map(entry => entry.id)).toEqual(["u-main", "a-main"])

    nativeSessionStore.appendOlderPage("s1", page([
      { type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } },
      { type: "message", id: "a-side", parentId: "u-root", message: { role: "assistant", content: "side" } },
    ]))
    expect(nativeSessionStore.getActiveBranch("s1").map(entry => entry.id)).toEqual(["u-root", "u-main", "a-main"])
    expect(nativeSessionStore.getHistoryState("s1")).toEqual({ hasMore: false, beforeCursor: undefined })
  })

  it("builds transient native-like messages and clears them after a persisted page refresh", () => {
    nativeSessionStore.replace(snapshot("s1", 1, "u-root"))
    nativeSessionStore.replaceFirstPage("s1", page([
      { type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } },
    ]))
    nativeSessionStore.applyNativeEvent("s1", {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "par" }] },
    }, meta(1, "assistant", 1))
    nativeSessionStore.applyNativeEvent("s1", {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    }, meta(2, "assistant", 2))
    expect(nativeSessionStore.getActiveBranch("s1").at(-1)?.message).toMatchObject({ role: "assistant" })
    expect(nativeSessionStore.getStreamingEntryIds("s1").size).toBe(1)

    const updated = snapshot("s1", 2, "a-persisted")
    updated.runtime.isStreaming = true
    nativeSessionStore.replace(updated)
    nativeSessionStore.replaceFirstPage("s1", {
      head: updated.native,
      items: [
        { type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } },
        { type: "message", id: "a-persisted", parentId: "u-root", message: { role: "assistant", content: "complete" } },
      ],
      checkpoint: { position: { epoch: "worker-epoch", sequence: 3 } },
      hasMore: false,
    })
    expect(nativeSessionStore.getActiveBranch("s1").map(entry => entry.id)).toEqual(["u-root", "a-persisted"])
    expect(nativeSessionStore.getStreamingEntryIds("s1").size).toBe(0)
  })

  it("does not erase an active transient message when a branch refresh races with streaming", () => {
    const running = snapshot("s1", 1, "u-root")
    running.runtime.isStreaming = true
    nativeSessionStore.replace(running)
    nativeSessionStore.replaceFirstPage("s1", {
      head: running.native,
      items: [{ type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } }],
      checkpoint: { position: { epoch: "worker-epoch", sequence: 0 } },
      hasMore: false,
    })
    nativeSessionStore.applyNativeEvent("s1", {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "par" }] },
    }, meta(1, "assistant", 1))

    nativeSessionStore.replaceFirstPage("s1", {
      head: running.native,
      items: [{ type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } }],
      checkpoint: { position: { epoch: "worker-epoch", sequence: 0 } },
      hasMore: false,
    })
    expect(nativeSessionStore.getStreamingEntryIds("s1").size).toBe(1)
    expect(nativeSessionStore.applyNativeEvent("s1", {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    }, meta(2, "assistant", 2))).toBe(true)
    expect(nativeSessionStore.getActiveBranch("s1").at(-1)?.message).toMatchObject({
      content: [{ type: "text", text: "partial" }],
    })
  })

  it("restores the current Pi streaming message from a native branch page", () => {
    const running = snapshot("s1", 1, "u-root")
    running.runtime.isStreaming = true
    nativeSessionStore.replace(running)
    nativeSessionStore.replaceFirstPage("s1", {
      head: running.native,
      items: [{ type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } }],
      checkpoint: {
        position: { epoch: "worker-epoch", sequence: 2 },
        liveMessage: {
          id: "assistant",
          revision: 2,
          phase: "streaming",
          message: { role: "assistant", content: [{ type: "text", text: "already streaming" }] },
        },
      },
      hasMore: false,
    })

    const live = nativeSessionStore.getActiveBranch("s1").at(-1)
    expect(live?.parentId).toBe("u-root")
    expect(live?.message).toMatchObject({ role: "assistant" })
    expect(nativeSessionStore.getStreamingEntryIds("s1").has(String(live?.id))).toBe(true)
    expect(nativeSessionStore.applyNativeEvent("s1", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    }, meta(1, "assistant", 1))).toBe(false)
    expect(nativeSessionStore.applyNativeEvent("s1", { type: "agent_settled" }, {
      position: { epoch: "worker-epoch", sequence: 2 },
    })).toBe(false)
    expect(nativeSessionStore.getActiveBranch("s1")).toHaveLength(2)
    expect(nativeSessionStore.getNativeEventStreaming("s1")).toBe(true)
  })

  it("uses the accepted page leaf when the branch is newer than the snapshot", () => {
    const olderSnapshot = snapshot("s1", 1, "a-old")
    nativeSessionStore.replace(olderSnapshot)
    nativeSessionStore.replaceFirstPage("s1", {
      head: { ...olderSnapshot.native, revision: 2, leafId: "a-new", entryCount: 4 },
      items: [
        { type: "message", id: "u-old", parentId: null, message: { role: "user", content: "old" } },
        { type: "message", id: "a-old", parentId: "u-old", message: { role: "assistant", content: "old" } },
        { type: "message", id: "u-new", parentId: "a-old", message: { role: "user", content: "new" } },
        { type: "message", id: "a-new", parentId: "u-new", message: { role: "assistant", content: "new" } },
      ],
      checkpoint: { position: { epoch: "worker-epoch", sequence: 4 } },
      hasMore: false,
    })

    expect(nativeSessionStore.getActiveBranch("s1").map(entry => entry.id)).toEqual([
      "u-old", "a-old", "u-new", "a-new",
    ])
  })

  it("does not revive an older live checkpoint from an out-of-order branch response", () => {
    const running = snapshot("s1", 1, "u-root")
    running.runtime.isStreaming = true
    nativeSessionStore.replace(running)
    nativeSessionStore.replaceFirstPage("s1", {
      head: running.native,
      items: [{ type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } }],
      checkpoint: { position: { epoch: "worker-epoch", sequence: 0 } },
      hasMore: false,
    })
    nativeSessionStore.applyNativeEvent("s1", {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "current" }] },
    }, meta(5, "current-live", 1))

    nativeSessionStore.replaceFirstPage("s1", {
      head: running.native,
      items: [{ type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } }],
      checkpoint: {
        position: { epoch: "worker-epoch", sequence: 3 },
        liveMessage: {
          id: "old-live",
          revision: 3,
          phase: "streaming",
          message: { role: "assistant", content: [{ type: "text", text: "stale" }] },
        },
      },
      hasMore: false,
    })

    const branch = nativeSessionStore.getActiveBranch("s1")
    expect(branch).toHaveLength(2)
    expect(branch.at(-1)?.message).toMatchObject({ content: [{ text: "current" }] })
  })

  it("keeps a settled transient when an older page arrives afterward", () => {
    const running = snapshot("s1", 1, "u-root")
    running.runtime.isStreaming = true
    nativeSessionStore.replace(running)
    nativeSessionStore.replaceFirstPage("s1", {
      head: running.native,
      items: [{ type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } }],
      checkpoint: { position: { epoch: "worker-epoch", sequence: 0 } },
      hasMore: false,
    })
    nativeSessionStore.applyNativeEvent("s1", {
      type: "message_end",
      message: { role: "assistant", content: "complete" },
    }, meta(6, "answer", 6))
    nativeSessionStore.applyNativeEvent("s1", { type: "agent_settled" }, {
      position: { epoch: "worker-epoch", sequence: 10 },
    })

    nativeSessionStore.replaceFirstPage("s1", {
      head: running.native,
      items: [{ type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } }],
      checkpoint: {
        position: { epoch: "worker-epoch", sequence: 8 },
        liveMessage: {
          id: "answer",
          revision: 6,
          phase: "persisting",
          message: { role: "assistant", content: "complete" },
        },
      },
      hasMore: false,
    })

    expect(nativeSessionStore.getActiveBranch("s1").at(-1)?.message).toMatchObject({ content: "complete" })
  })

  it("does not let an older history page lower the latest branch revision", () => {
    const initial = snapshot("s1", 1, "a1")
    nativeSessionStore.replace(initial)
    expect(nativeSessionStore.replaceFirstPage("s1", {
      head: { ...initial.native, revision: 3, leafId: "a3" },
      items: [{ type: "message", id: "a3", parentId: null, message: { role: "assistant", content: "newest" } }],
      checkpoint: { position: { epoch: "worker-epoch", sequence: 3 } },
      hasMore: true,
      beforeCursor: "older",
    })).toBe(true)
    nativeSessionStore.appendOlderPage("s1", {
      head: { ...initial.native, revision: 1 },
      items: [{ type: "message", id: "a1", parentId: null, message: { role: "assistant", content: "old" } }],
      hasMore: false,
    })

    expect(nativeSessionStore.replaceFirstPage("s1", {
      head: { ...initial.native, revision: 2, leafId: "a2" },
      items: [{ type: "message", id: "a2", parentId: null, message: { role: "assistant", content: "stale" } }],
      checkpoint: { position: { epoch: "worker-epoch", sequence: 2 } },
      hasMore: false,
    })).toBe(false)
    expect(nativeSessionStore.getActiveBranch("s1").at(-1)?.id).toBe("a3")
  })

  it("clears transient tool execution state after an idle branch refresh", () => {
    const idle = snapshot("s1", 1, "a1")
    nativeSessionStore.replace(idle)
    nativeSessionStore.applyNativeEvent("s1", {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      result: { content: "done" },
      isError: false,
    }, { position: { epoch: "worker-epoch", sequence: 3 } })
    expect(nativeSessionStore.getLiveTools("s1").size).toBe(1)

    nativeSessionStore.replaceFirstPage("s1", {
      head: idle.native,
      items: [{ type: "message", id: "a1", parentId: null, message: { role: "assistant", content: [] } }],
      checkpoint: { position: { epoch: "worker-epoch", sequence: 4 } },
      hasMore: false,
    })
    expect(nativeSessionStore.getLiveTools("s1").size).toBe(0)
  })

  it("retains loaded history when a later first page contains only the new turn", () => {
    const initial = snapshot("s1", 1, "a-old")
    nativeSessionStore.replace(initial)
    nativeSessionStore.replaceFirstPage("s1", {
      head: { ...initial.native, leafId: "a-old", entryCount: 4 },
      items: [
        { type: "message", id: "u-root", parentId: null, message: { role: "user", content: "root" } },
        { type: "message", id: "a-old", parentId: "u-root", message: { role: "assistant", content: "old" } },
        { type: "label", id: "label-1", targetId: "a-old" },
        { type: "session_info", id: "info-1" },
      ],
      checkpoint: { position: { epoch: "worker-epoch", sequence: 0 } },
      hasMore: false,
    })

    const updated = snapshot("s1", 2, "a-new")
    nativeSessionStore.replace(updated)
    nativeSessionStore.replaceFirstPage("s1", {
      head: { ...updated.native, entryCount: 2 },
      items: [
        { type: "message", id: "u-new", parentId: "a-old", message: { role: "user", content: "new" } },
        { type: "message", id: "a-new", parentId: "u-new", message: { role: "assistant", content: "answer" } },
      ],
      checkpoint: { position: { epoch: "worker-epoch", sequence: 4 } },
      hasMore: false,
    })

    expect(nativeSessionStore.getActiveBranch("s1").map(entry => entry.id)).toEqual([
      "u-root", "a-old", "u-new", "a-new",
    ])
  })

  it("detects a transient turn whose persisted parent is not loaded", () => {
    nativeSessionStore.replace(snapshot("s1", 1, "missing-leaf"))
    nativeSessionStore.replaceFirstPage("s1", page([
      { type: "message", id: "unrelated", parentId: null, message: { role: "user", content: "cached" } },
    ]))
    nativeSessionStore.applyNativeEvent("s1", {
      type: "message_start",
      message: { role: "user", content: "new" },
    }, meta(1, "user", 1))

    expect(nativeSessionStore.hasDisconnectedTransientBranch("s1")).toBe(true)
  })
})
