import type { PiNativeSessionInfo } from './nativeApi'

class PiSessionInfoStore {
  private all: PiNativeSessionInfo[] = []
  private byCwd = new Map<string, PiNativeSessionInfo[]>()

  replaceAll(sessions: PiNativeSessionInfo[]): PiNativeSessionInfo[] {
    this.all = sessions
    return this.all
  }

  replaceForCwd(cwd: string, sessions: PiNativeSessionInfo[]): PiNativeSessionInfo[] {
    this.byCwd.set(pathKey(cwd), sessions)
    return sessions
  }

  getAll(): readonly PiNativeSessionInfo[] {
    return this.all
  }

  getForCwd(cwd: string): readonly PiNativeSessionInfo[] {
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
