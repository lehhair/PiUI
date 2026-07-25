/**
 * Minimal projection store for Phase 4 — holds SessionSnapshotV1 timeline.
 * Full ChatArea wiring comes next; this is the data entry point.
 */
import type { SessionSnapshotV1, TimelineItemV1 } from "@piui/protocol"

type Listener = () => void

class SessionProjectionStore {
  private snapshots = new Map<string, SessionSnapshotV1>()
  private activeSessionId: string | null = null
  private listeners = new Set<Listener>()

  getSnapshot(sessionId = this.activeSessionId): SessionSnapshotV1 | null {
    return sessionId ? this.snapshots.get(sessionId) ?? null : null
  }

  getTimeline(sessionId = this.activeSessionId): TimelineItemV1[] {
    return this.getSnapshot(sessionId)?.timeline ?? []
  }

  getSessionIds(): string[] {
    return [...this.snapshots.keys()]
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId
  }

  replace(snapshot: SessionSnapshotV1, options?: { activate?: boolean }): boolean {
    const existing = this.snapshots.get(snapshot.session.id)
    if (existing?.epoch === snapshot.epoch && existing.sequence >= snapshot.sequence) return false
    this.snapshots.set(snapshot.session.id, snapshot)
    if (options?.activate !== false) this.activeSessionId = snapshot.session.id
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
      if (this.activeSessionId === sessionId) this.activeSessionId = null
    } else {
      this.snapshots.clear()
      this.activeSessionId = null
    }
    for (const l of this.listeners) l()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const sessionProjectionStore = new SessionProjectionStore()
