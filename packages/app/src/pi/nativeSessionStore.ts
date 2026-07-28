import type { PiNativeEntriesPageV1, SessionSnapshotV1 } from "@piui/protocol"
import type { NativeToolExecution, PiNativeEntry } from "./nativeEntriesToMessages"

type Listener = () => void

interface NativeSessionState {
  entries: Map<string, PiNativeEntry>
  beforeCursor?: string
  hasMore: boolean
  pageLoaded: boolean
  pageEpoch?: string
  pageRevision?: number
  transient: PiNativeEntry[]
  streamingEntryIds: Set<string>
  liveTools: Map<string, NativeToolExecution>
  nativeEventStreaming?: boolean
  transientCounter: number
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function messageRole(entry: PiNativeEntry): unknown {
  return record(entry.message).role
}

class NativeSessionStore {
  private snapshots = new Map<string, SessionSnapshotV1>()
  private native = new Map<string, NativeSessionState>()
  private activeSessionId: string | null = null
  private listeners = new Set<Listener>()

  getSnapshot(sessionId = this.activeSessionId): SessionSnapshotV1 | null {
    return sessionId ? this.snapshots.get(sessionId) ?? null : null
  }

  private ensureNative(sessionId: string): NativeSessionState {
    let state = this.native.get(sessionId)
    if (!state) {
      state = {
        entries: new Map(),
        hasMore: false,
        pageLoaded: false,
        transient: [],
        streamingEntryIds: new Set(),
        liveTools: new Map(),
        transientCounter: 0,
      }
      this.native.set(sessionId, state)
    }
    return state
  }

  hasNativePage(sessionId: string): boolean {
    return this.native.get(sessionId)?.pageLoaded ?? false
  }

  getHistoryState(sessionId: string): { hasMore: boolean; beforeCursor?: string } {
    const state = this.native.get(sessionId)
    return { hasMore: state?.hasMore ?? false, beforeCursor: state?.beforeCursor }
  }

  getActiveBranch(sessionId = this.activeSessionId): PiNativeEntry[] {
    if (!sessionId) return []
    const snapshot = this.snapshots.get(sessionId)
    const state = this.native.get(sessionId)
    if (!snapshot || !state) return []
    const all = new Map(state.entries)
    for (const entry of state.transient) {
      if (typeof entry.id === "string") all.set(entry.id, entry)
    }
    const transientLeaf = state.transient.at(-1)?.id
    let id = typeof transientLeaf === "string" ? transientLeaf : snapshot.native.leafId
    const branch: PiNativeEntry[] = []
    const visited = new Set<string>()
    while (id && !visited.has(id)) {
      visited.add(id)
      const entry = all.get(id)
      if (!entry) break
      branch.push(entry)
      id = typeof entry.parentId === "string" ? entry.parentId : null
    }
    return branch.reverse()
  }

  getStreamingEntryIds(sessionId: string): ReadonlySet<string> {
    return this.native.get(sessionId)?.streamingEntryIds ?? new Set()
  }

  getLiveTools(sessionId: string): ReadonlyMap<string, NativeToolExecution> {
    return this.native.get(sessionId)?.liveTools ?? new Map()
  }

  getNativeEventStreaming(sessionId: string): boolean | undefined {
    return this.native.get(sessionId)?.nativeEventStreaming
  }

  hasDisconnectedTransientBranch(sessionId: string): boolean {
    const state = this.native.get(sessionId)
    const snapshot = this.snapshots.get(sessionId)
    if (!state || !snapshot || state.transient.length === 0 || snapshot.native.entryCount === 0) return false
    const branch = this.getActiveBranch(sessionId)
    return !branch.some(entry => typeof entry.id === "string" && state.entries.has(entry.id))
  }

  getSessionIds(): string[] {
    return [...this.snapshots.keys()]
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId
  }

  replace(snapshot: SessionSnapshotV1, options?: { activate?: boolean }): { accepted: boolean; nativeChanged: boolean } {
    const existing = this.snapshots.get(snapshot.session.id)
    if (existing?.epoch === snapshot.epoch && existing.sequence >= snapshot.sequence) {
      return { accepted: false, nativeChanged: false }
    }
    const nativeChanged = !existing || existing.native.epoch !== snapshot.native.epoch ||
      existing.native.revision !== snapshot.native.revision || existing.native.leafId !== snapshot.native.leafId ||
      existing.native.entryCount !== snapshot.native.entryCount
    this.snapshots.set(snapshot.session.id, snapshot)
    if (options?.activate !== false) this.activeSessionId = snapshot.session.id
    for (const l of this.listeners) l()
    return { accepted: true, nativeChanged }
  }

  replaceFirstPage(sessionId: string, page: PiNativeEntriesPageV1): boolean {
    const snapshot = this.snapshots.get(sessionId)
    if (!snapshot || page.head.epoch !== snapshot.native.epoch || page.head.revision < snapshot.native.revision) return false
    const state = this.ensureNative(sessionId)
    if (state.pageEpoch === page.head.epoch && state.pageRevision !== undefined && page.head.revision < state.pageRevision) return false
    if (state.pageEpoch !== page.head.epoch) state.entries.clear()
    for (const item of page.items) {
      if (typeof item.id === "string") state.entries.set(item.id, item as PiNativeEntry)
    }
    const canKeepOlderCursor = state.pageLoaded && state.pageEpoch === page.head.epoch && state.beforeCursor !== undefined
    if (!canKeepOlderCursor) {
      state.beforeCursor = page.beforeCursor
      state.hasMore = page.hasMore
    }
    state.pageLoaded = true
    state.pageEpoch = page.head.epoch
    state.pageRevision = page.head.revision
    state.transient = []
    state.streamingEntryIds.clear()
    state.liveTools.clear()
    state.nativeEventStreaming = undefined
    for (const l of this.listeners) l()
    return true
  }

  appendOlderPage(sessionId: string, page: PiNativeEntriesPageV1): boolean {
    const state = this.native.get(sessionId)
    if (!state || page.head.epoch !== state.pageEpoch) return false
    for (const item of page.items) {
      if (typeof item.id === "string") state.entries.set(item.id, item as PiNativeEntry)
    }
    state.beforeCursor = page.beforeCursor
    state.hasMore = page.hasMore
    state.pageRevision = page.head.revision
    for (const l of this.listeners) l()
    return true
  }

  applyNativeEvent(sessionId: string, value: unknown): boolean {
    const event = record(value)
    if (typeof event.type !== "string") return false
    const state = this.ensureNative(sessionId)
    const now = Date.now()
    const makeId = (role: unknown) => `transient-${role === "user" ? "u" : role === "toolResult" ? "tr" : "a"}-${++state.transientCounter}`
    const currentLeaf = state.transient.at(-1)?.id ?? this.snapshots.get(sessionId)?.native.leafId ?? null
    const incomingMessage = record(event.message)
    const role = incomingMessage.role
    const findStreaming = (wantedRole: unknown) => [...state.transient].reverse().find(entry =>
      messageRole(entry) === wantedRole && typeof entry.id === "string" && state.streamingEntryIds.has(entry.id),
    )

    if (event.type === "message_start") {
      if (role !== "user" && role !== "assistant" && role !== "toolResult") return false
      const id = makeId(role)
      state.transient.push({ type: "message", id, parentId: currentLeaf, timestamp: now, message: incomingMessage })
      state.streamingEntryIds.add(id)
      if (role === "assistant") state.nativeEventStreaming = true
    } else if (event.type === "message_update") {
      const target = findStreaming(role === "user" || role === "toolResult" ? role : "assistant")
      if (!target) return false
      target.message = incomingMessage
    } else if (event.type === "message_end") {
      if (role !== "user" && role !== "assistant" && role !== "toolResult") return false
      let target = findStreaming(role)
      if (!target) {
        const id = makeId(role)
        target = { type: "message", id, parentId: currentLeaf, timestamp: now, message: incomingMessage }
        state.transient.push(target)
      } else {
        target.message = incomingMessage
      }
      if (typeof target.id === "string") state.streamingEntryIds.delete(target.id)
    } else if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
      state.liveTools.set(event.toolCallId, {
        status: "running",
        args: event.args,
        startedAt: now,
      })
    } else if (event.type === "tool_execution_update" && typeof event.toolCallId === "string") {
      const current = state.liveTools.get(event.toolCallId)
      const partial = record(event.partialResult)
      state.liveTools.set(event.toolCallId, {
        status: "running",
        args: current?.args,
        result: partial.content ?? event.partialResult,
        details: partial.details,
        startedAt: current?.startedAt ?? now,
      })
    } else if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      const current = state.liveTools.get(event.toolCallId)
      const result = record(event.result)
      state.liveTools.set(event.toolCallId, {
        status: event.isError === true || result.isError === true ? "error" : "completed",
        args: current?.args,
        result: result.content ?? event.result,
        details: result.details,
        startedAt: current?.startedAt ?? now,
        endedAt: now,
      })
    } else if (event.type === "agent_end" || event.type === "agent_settled" || event.type === "settled") {
      state.streamingEntryIds.clear()
      state.nativeEventStreaming = false
    } else {
      return false
    }
    for (const l of this.listeners) l()
    return true
  }

  activate(sessionId: string): void {
    if (this.activeSessionId === sessionId) return
    this.activeSessionId = sessionId
    for (const l of this.listeners) l()
  }

  clear(sessionId?: string) {
    if (sessionId) {
      this.snapshots.delete(sessionId)
      this.native.delete(sessionId)
      if (this.activeSessionId === sessionId) this.activeSessionId = null
    } else {
      this.snapshots.clear()
      this.native.clear()
      this.activeSessionId = null
    }
    for (const l of this.listeners) l()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const nativeSessionStore = new NativeSessionStore()
