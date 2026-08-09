import type { PiBranchPage, PiTimelineItem } from '../domain/index.js'
import { buildPiHistoryItems, buildPiLiveItems } from './index.js'

/**
 * Reference-stable timeline selection.
 *
 * The plain `selectPiTimelineItems` rebuilds a fresh object for every entry on
 * every call. During a streaming token storm the event stream calls
 * `setData` with a new branch page each chunk (updateLiveMessage shallow-
 * copies the page and replaces only `checkpoint.liveMessage`), so the
 * selector would re-create the whole timeline and every memoized row would
 * re-render — O(n) per chunk instead of O(1).
 *
 * The cache keys on the *items array reference* and reuses the **history**
 * items (persisted entries) verbatim while only the live message changes
 * (token storm): history item references stay identical, so memoized rows
 * hold and only the live row re-renders. The live item itself is rebuilt per
 * chunk from the checkpoint — caching it too would freeze the streaming text
 * (the "content pops out only at the end" bug), because updateLiveMessage
 * keeps `items` identity while updating `checkpoint.liveMessage`.
 * When `items` is a different array (branch.get refresh merged entries,
 * prepend loaded older history, tool results paired), the history is rebuilt
 * from scratch — a full rebuild is O(n) but happens once per event, not per
 * token.
 */
const historyCache = new Map<string, { itemsRef: readonly unknown[]; history: PiTimelineItem[] }>()

const CACHE_LIMIT = 64

/**
 * Select timeline items for a session with stable references while the
 * underlying branch page reference stays unchanged.
 * @param sessionId - Session identity for the cache key.
 * @param branch - Branch page (null when no session).
 * @returns Timeline items; history item references are stable across chunks,
 *          the live streaming item is fresh per chunk.
 */
export function selectPiTimelineItemsCached(
  sessionId: string | null,
  branch: PiBranchPage | null,
): PiTimelineItem[] {
  if (!branch || !sessionId) {
    if (branch) return buildPiHistoryItems(branch).concat(buildPiLiveItems(branch))
    return []
  }

  const cached = historyCache.get(sessionId)
  let history: PiTimelineItem[]
  if (cached && cached.itemsRef === branch.items) {
    history = cached.history
  } else {
    history = buildPiHistoryItems(branch)
    historyCache.set(sessionId, { itemsRef: branch.items, history })
    while (historyCache.size > CACHE_LIMIT) {
      historyCache.delete(historyCache.keys().next().value!)
    }
  }

  const liveItems = buildPiLiveItems(branch)
  if (liveItems.length === 0) return history
  return history.concat(liveItems)
}

/** Drop all cached timeline items (server switch / logout). */
export function clearPiTimelineItemCache(): void {
  historyCache.clear()
}
