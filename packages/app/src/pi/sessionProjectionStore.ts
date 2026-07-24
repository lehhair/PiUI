/**
 * Minimal projection store for Phase 4 — holds SessionSnapshotV1 timeline.
 * Full ChatArea wiring comes next; this is the data entry point.
 */
import type { SessionSnapshotV1, TimelineItemV1 } from "@piui/protocol"

type Listener = () => void

class SessionProjectionStore {
  private snapshot: SessionSnapshotV1 | null = null
  private listeners = new Set<Listener>()

  getSnapshot(): SessionSnapshotV1 | null {
    return this.snapshot
  }

  getTimeline(): TimelineItemV1[] {
    return this.snapshot?.timeline ?? []
  }

  replace(snapshot: SessionSnapshotV1) {
    this.snapshot = snapshot
    for (const l of this.listeners) l()
  }

  clear() {
    this.snapshot = null
    for (const l of this.listeners) l()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const sessionProjectionStore = new SessionProjectionStore()
