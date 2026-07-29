import type { SessionInfo } from '@earendil-works/pi-coding-agent'

class PiSessionInfoStore {
  private all: SessionInfo[] = []
  private byCwd = new Map<string, SessionInfo[]>()

  replaceAll(sessions: SessionInfo[]): SessionInfo[] {
    this.all = sessions
    return this.all
  }

  replaceForCwd(cwd: string, sessions: SessionInfo[]): SessionInfo[] {
    this.byCwd.set(pathKey(cwd), sessions)
    return sessions
  }

  getAll(): readonly SessionInfo[] {
    return this.all
  }

  getForCwd(cwd: string): readonly SessionInfo[] {
    return this.byCwd.get(pathKey(cwd)) ?? []
  }

  clear(): void {
    this.all = []
    this.byCwd.clear()
  }
}

export const piSessionInfoStore = new PiSessionInfoStore()

function pathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}
