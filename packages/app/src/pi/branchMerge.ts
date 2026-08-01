import type { PiBranchPage } from './domain/index.js'

/**
 * Merge a freshly-fetched latest page with locally held branch data.
 *
 * Local data may contain older items loaded via pagination. Rules:
 * - Different epoch: session file was replaced — take latest wholesale.
 * - Local leaf no longer in the latest page: branch moved (tree
 *   navigation/undo) — local data is stale, take latest wholesale.
 *   TUI parity: navigateTree rebuilds the context wholesale.
 * - Overlapping items (by entry id): latest page wins; older local items
 *   not in the latest page are kept in front.
 * - No overlap at all: branch structure changed (fork/tree navigation) —
 *   local history is stale, take latest wholesale.
 * - When older items survive, keep local beforeCursor/hasMore (they
 *   describe the oldest local edge); otherwise take latest page's.
 */
export function mergeLatestBranchPage(current: PiBranchPage | null, latest: PiBranchPage): PiBranchPage {
  if (!current) return latest
  if (current.head.epoch !== latest.head.epoch) return latest

  const latestIds = new Set(latest.items.map(item => item.id))

  const localLeaf = current.items[current.items.length - 1]
  if (localLeaf && !latestIds.has(localLeaf.id)) return latest

  const olderKept = current.items.filter(item => !latestIds.has(item.id))

  if (olderKept.length === 0) return latest
  if (olderKept.length === current.items.length) return latest

  return {
    ...latest,
    items: [...olderKept, ...latest.items],
    beforeCursor: current.beforeCursor ?? latest.beforeCursor,
    hasMore: current.hasMore || latest.hasMore,
  }
}
