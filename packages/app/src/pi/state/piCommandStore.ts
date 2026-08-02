import type { CommandRecord } from '@piui/protocol'

class PiCommandStore {
  private byId = new Map<string, CommandRecord>()
  private snapshot: readonly CommandRecord[] = []
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(listener => listener())
  }

  upsert(command: CommandRecord): void {
    this.byId.set(command.id, command)
    this.snapshot = [...this.byId.values()]
    this.notify()
  }

  get(commandId: string): CommandRecord | null {
    return this.byId.get(commandId) ?? null
  }

  getForSession(sessionId: string): readonly CommandRecord[] {
    return this.snapshot.filter(command => command.sessionId === sessionId)
  }

  getSnapshot(): readonly CommandRecord[] {
    return this.snapshot
  }

  clearSession(sessionId: string): void {
    let changed = false
    for (const [commandId, command] of this.byId) {
      if (command.sessionId !== sessionId) continue
      this.byId.delete(commandId)
      changed = true
    }
    if (!changed) return
    this.snapshot = [...this.byId.values()]
    this.notify()
  }

  clearAll(): void {
    if (this.byId.size === 0) return
    this.byId.clear()
    this.snapshot = []
    this.notify()
  }
}

export const piCommandStore = new PiCommandStore()
