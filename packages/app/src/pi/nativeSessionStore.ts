import type {
  PiNativeEntriesPageV1,
  PiNativeEventMetaV1,
  PiNativeEventPositionV1,
  SessionSnapshotV1,
} from "@piui/protocol"
import type { NativeToolExecution, PiNativeEntry } from "./nativeEntriesToMessages"

type Listener = () => void

interface NativeSessionState {
  entries: Map<string, PiNativeEntry>
  beforeCursor?: string
  hasMore: boolean
  pageLoaded: boolean
  pageEpoch?: string
  pageRevision?: number
  pageLeafId?: string | null
  transient: TransientNativeEntry[]
  streamingEntryIds: Set<string>
  liveTools: Map<string, NativeToolExecution>
  nativeEventStreaming?: boolean
  checkpointPosition?: PiNativeEventPositionV1
}

interface TransientNativeEntry {
  entry: PiNativeEntry
  liveId: string
  liveRevision: number
  phase: "streaming" | "persisting"
  position: PiNativeEventPositionV1
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
    for (const { entry } of state.transient) {
      if (typeof entry.id === "string") all.set(entry.id, entry)
    }
    const transientLeaf = state.transient.at(-1)?.entry.id
    let id = typeof transientLeaf === "string"
      ? transientLeaf
      : state.pageLoaded ? state.pageLeafId ?? null : snapshot.native.leafId
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

  getTransientEntryIds(sessionId: string): ReadonlySet<string> {
    return new Set(this.native.get(sessionId)?.transient.flatMap(({ entry }) =>
      typeof entry.id === "string" ? [entry.id] : []
    ) ?? [])
  }

  getTransientEntries(sessionId: string): PiNativeEntry[] {
    return this.native.get(sessionId)?.transient.map(item => item.entry) ?? []
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
    if ((!existing?.runtime.isStreaming && snapshot.runtime.isStreaming) || existing?.native.epoch !== snapshot.native.epoch) {
      const state = this.native.get(snapshot.session.id)
      if (state) state.nativeEventStreaming = undefined
    }
    if (options?.activate !== false) this.activeSessionId = snapshot.session.id
    for (const l of this.listeners) l()
    return { accepted: true, nativeChanged }
  }

  replaceFirstPage(sessionId: string, page: PiNativeEntriesPageV1): boolean {
    const snapshot = this.snapshots.get(sessionId)
    const checkpoint = page.checkpoint
    if (!snapshot || !checkpoint || page.head.epoch !== snapshot.native.epoch || page.head.revision < snapshot.native.revision) return false
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
    state.pageLeafId = page.head.leafId

    const previousPosition = state.checkpointPosition
    const sameEventEpoch = previousPosition?.epoch === checkpoint.position.epoch
    const checkpointBehind = previousPosition?.epoch === checkpoint.position.epoch &&
      previousPosition.sequence > checkpoint.position.sequence
    if (previousPosition && !sameEventEpoch) {
      state.liveTools.clear()
    }
    state.transient = sameEventEpoch
      ? state.transient.filter(item => item.position.sequence > checkpoint.position.sequence)
      : []
    state.checkpointPosition = sameEventEpoch && previousPosition.sequence > checkpoint.position.sequence
      ? previousPosition
      : checkpoint.position

    const live = checkpointBehind ? undefined : checkpoint.liveMessage
    const liveMessage = record(live?.message)
    const liveRole = liveMessage.role
    if (live && (liveRole === "user" || liveRole === "assistant" || liveRole === "toolResult")) {
      let target = state.transient.find(item => item.liveId === live.id)
      if (!target) {
        const prefix = liveRole === "user" ? "u" : liveRole === "toolResult" ? "tr" : "a"
        const id = `transient-${prefix}-${live.id}`
        target = {
          entry: { type: "message", id, parentId: page.head.leafId, timestamp: Date.now(), message: liveMessage },
          liveId: live.id,
          liveRevision: live.revision,
          phase: live.phase,
          position: checkpoint.position,
        }
        state.transient.push(target)
      } else if (target.liveRevision <= live.revision) {
        target.entry.message = liveMessage
        target.liveRevision = live.revision
        target.phase = live.phase
      }
    }
    if (state.transient[0]) state.transient[0].entry.parentId = page.head.leafId
    state.streamingEntryIds = new Set(state.transient.flatMap(item =>
      item.phase === "streaming" && typeof item.entry.id === "string" ? [item.entry.id] : [],
    ))
    state.nativeEventStreaming = state.transient.some(item =>
      item.phase === "streaming" && messageRole(item.entry) === "assistant"
    ) ? true : undefined
    if (!snapshot.runtime.isStreaming && !checkpoint.liveMessage) state.liveTools.clear()
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
    state.pageRevision = Math.max(state.pageRevision ?? 0, page.head.revision)
    for (const l of this.listeners) l()
    return true
  }

  applyNativeEvent(sessionId: string, value: unknown, meta: PiNativeEventMetaV1): boolean {
    const event = record(value)
    if (typeof event.type !== "string") return false
    const state = this.ensureNative(sessionId)
    const now = Date.now()
    const isMessageEvent = event.type === "message_start" || event.type === "message_update" || event.type === "message_end"
    const isCheckpointCoveredEvent = isMessageEvent || event.type === "agent_end" ||
      event.type === "agent_settled" || event.type === "settled"
    const previousPosition = state.checkpointPosition
    if (isCheckpointCoveredEvent && previousPosition?.epoch === meta.position.epoch && meta.position.sequence <= previousPosition.sequence) {
      return false
    }
    if (isCheckpointCoveredEvent && previousPosition && previousPosition.epoch !== meta.position.epoch) {
      state.transient = []
      state.streamingEntryIds.clear()
      state.liveTools.clear()
      state.nativeEventStreaming = undefined
    }
    if (isCheckpointCoveredEvent) state.checkpointPosition = meta.position

    const currentLeaf = state.transient.at(-1)?.entry.id ??
      (state.pageLoaded ? state.pageLeafId : this.snapshots.get(sessionId)?.native.leafId) ?? null
    const incomingMessage = record(event.message)
    const role = incomingMessage.role
    const live = meta.liveMessage
    const findLive = () => live ? state.transient.find(item => item.liveId === live.id) : undefined
    const createLive = (phase: "streaming" | "persisting") => {
      if (!live) return undefined
      const prefix = role === "user" ? "u" : role === "toolResult" ? "tr" : "a"
      const item: TransientNativeEntry = {
        entry: {
          type: "message",
          id: `transient-${prefix}-${live.id}`,
          parentId: currentLeaf,
          timestamp: now,
          message: incomingMessage,
        },
        liveId: live.id,
        liveRevision: live.revision,
        phase,
        position: meta.position,
      }
      state.transient.push(item)
      return item
    }

    if (event.type === "message_start") {
      if (!live || (role !== "user" && role !== "assistant" && role !== "toolResult")) return false
      const target = findLive() ?? createLive("streaming")
      if (!target) return false
      target.entry.message = incomingMessage
      target.liveRevision = live.revision
      target.phase = "streaming"
      target.position = meta.position
      if (typeof target.entry.id === "string") state.streamingEntryIds.add(target.entry.id)
      if (role === "assistant") state.nativeEventStreaming = true
    } else if (event.type === "message_update") {
      if (!live || (role !== "user" && role !== "assistant" && role !== "toolResult")) return false
      const target = findLive() ?? createLive("streaming")
      if (!target) return false
      if (live.revision >= target.liveRevision) target.entry.message = incomingMessage
      target.liveRevision = Math.max(target.liveRevision, live.revision)
      target.phase = "streaming"
      target.position = meta.position
      if (typeof target.entry.id === "string") state.streamingEntryIds.add(target.entry.id)
    } else if (event.type === "message_end") {
      if (!live || (role !== "user" && role !== "assistant" && role !== "toolResult")) return false
      const target = findLive() ?? createLive("persisting")
      if (!target) return false
      if (live.revision >= target.liveRevision) target.entry.message = incomingMessage
      target.liveRevision = Math.max(target.liveRevision, live.revision)
      target.phase = "persisting"
      target.position = meta.position
      if (typeof target.entry.id === "string") state.streamingEntryIds.delete(target.entry.id)
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
      for (const item of state.transient) {
        item.phase = "persisting"
        item.position = meta.position
      }
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
