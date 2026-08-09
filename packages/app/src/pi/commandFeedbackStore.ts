/**
 * Command feedback log — a per-session, persistent record of every slash
 * command the client executed and what it did. Notifications are transient
 * and truncated; this store keeps the full message so the extension panel can
 * render command reactions with detail.
 */

export type CommandFeedbackStatus = 'ok' | 'error' | 'info'

export interface CommandFeedbackEntry {
  id: string
  sessionId: string
  /** Command name without the leading slash, e.g. "compact". */
  command: string
  args?: string
  status: CommandFeedbackStatus
  message: string
  at: number
}

interface CommandFeedbackSnapshot {
  sessions: Readonly<Record<string, ReadonlyArray<CommandFeedbackEntry>>>
}

const MAX_ENTRIES_PER_SESSION = 100

let current: CommandFeedbackSnapshot = { sessions: {} }
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export const commandFeedbackStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  getSnapshot(): CommandFeedbackSnapshot {
    return current
  },

  add(entry: Omit<CommandFeedbackEntry, 'id' | 'at'>): void {
    const full: CommandFeedbackEntry = {
      ...entry,
      id: globalThis.crypto?.randomUUID?.() ?? `${entry.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      at: Date.now(),
    }
    const session = current.sessions[entry.sessionId] ?? []
    const nextSession = [full, ...session].slice(0, MAX_ENTRIES_PER_SESSION)
    current = { sessions: { ...current.sessions, [entry.sessionId]: nextSession } }
    emit()
  },

  remove(sessionId: string): void {
    if (!(sessionId in current.sessions)) return
    const sessions = { ...current.sessions }
    delete sessions[sessionId]
    current = { sessions }
    emit()
  },

  reset(): void {
    current = { sessions: {} }
    emit()
  },
}
