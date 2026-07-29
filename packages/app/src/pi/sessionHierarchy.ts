import type { UiSession } from '../types/session'

export type FlatSessionHierarchyRow = {
  session: UiSession
  depth: number
  visualDepth: number
  truncated: boolean
}

export function flattenSessionHierarchy(
  parentId: string,
  children: UiSession[],
  childrenByParent?: Map<string, UiSession[]>,
  maxDepth = 64,
  maxVisualDepth = 3,
): FlatSessionHierarchyRow[] {
  const rows: FlatSessionHierarchyRow[] = []
  const visited = new Set([parentId])
  const stack = [...children].reverse().map(session => ({ session, depth: 1 }))

  while (stack.length > 0) {
    const current = stack.pop()!
    if (visited.has(current.session.id)) continue
    visited.add(current.session.id)

    const descendants = childrenByParent?.get(current.session.id) ?? []
    const truncated = current.depth >= maxDepth && descendants.length > 0
    rows.push({
      session: current.session,
      depth: current.depth,
      visualDepth: Math.min(current.depth, maxVisualDepth),
      truncated,
    })

    if (truncated) continue
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      stack.push({ session: descendants[index], depth: current.depth + 1 })
    }
  }

  return rows
}

export function hasSafeParentChain(
  sessionId: string,
  parentId: string,
  parentIdBySession: Map<string, string>,
  maxDepth = 64,
): boolean {
  const visited = new Set([sessionId])
  let current: string | undefined = parentId
  let depth = 0
  while (current) {
    if (visited.has(current)) return false
    visited.add(current)
    depth += 1
    if (depth > maxDepth) return false
    current = parentIdBySession.get(current)
  }
  return true
}
