import type { ActiveSessionEntry } from '../../../store/activeSessionStore'

export interface ActiveSessionTree {
  rootEntries: ActiveSessionEntry[]
  childrenByParent: Map<string, ActiveSessionEntry[]>
}

export function buildActiveSessionTree(
  busySessions: ActiveSessionEntry[],
  findParentId: (sessionId: string) => string | undefined,
): ActiveSessionTree {
  const busySessionIds = new Set(busySessions.map(entry => entry.sessionId))
  const rootEntries: ActiveSessionEntry[] = []
  const childrenByParent = new Map<string, ActiveSessionEntry[]>()

  for (const entry of busySessions) {
    const parentId = findParentId(entry.sessionId)

    if (!parentId || !busySessionIds.has(parentId)) {
      rootEntries.push(entry)
      continue
    }

    const siblings = childrenByParent.get(parentId)
    if (siblings) {
      siblings.push(entry)
    } else {
      childrenByParent.set(parentId, [entry])
    }
  }

  return { rootEntries, childrenByParent }
}
