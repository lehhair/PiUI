import { useMemo, useRef } from 'react'
import { getMessageText, type Message } from '../../types/message'
import { buildOutlineSourceEntries, type OutlineSourceEntry } from '../../components/outlineIndexModel'
import {
  buildVisibleMessageEntries,
  getVisibleMessageForkTargetId,
  type VisibleMessageEntry,
} from './chatAreaVisibility'
import {
  buildTurnDurationMap,
  buildTurnLatestAssistantIdSet,
  reconcileStableChatPages,
  type MessageGroupRow,
  type StableChatPage,
} from './chatPageModel'

export interface ChatPageViewModel {
  visibleMessageEntries: VisibleMessageEntry[]
  visibleMessages: Message[]
  pageRecords: StableChatPage[]
  outlineSourceEntries: OutlineSourceEntry[]
  outlineOwnerByMessageId: Map<string, string>
  forkTargetIdMap: Map<string, string | undefined>
  turnDurationMap: Map<string, number>
  turnLatestAssistantIds: Set<string>
}

interface StableOutlineModel {
  signature: string
  entries: OutlineSourceEntry[]
  ownerByMessageId: Map<string, string>
}

const OUTLINE_MODEL_CACHE_LIMIT = 16
const outlineModelCache = new Map<string, StableOutlineModel>()

function buildOutlineSignature(messages: Message[]): string {
  let signature = ''
  for (const message of messages) {
    signature += `${message.info.id}:${message.info.role}|`
    if (message.info.role === 'user') {
      signature += `${message.info.summary?.title ?? getMessageText(message)}|`
    }
  }
  return signature
}

function buildOutlineOwnerByMessageId(messages: Message[]): Map<string, string> {
  const ownerByMessageId = new Map<string, string>()
  let lastUserMessageId: string | null = null

  for (const message of messages) {
    if (message.info.role === 'user') lastUserMessageId = message.info.id
    if (lastUserMessageId) ownerByMessageId.set(message.info.id, lastUserMessageId)
  }

  return ownerByMessageId
}

function getStableOutlineModel(messages: Message[]): StableOutlineModel {
  const signature = buildOutlineSignature(messages)
  const cached = outlineModelCache.get(signature)
  if (cached) {
    outlineModelCache.delete(signature)
    outlineModelCache.set(signature, cached)
    return cached
  }

  const next: StableOutlineModel = {
    signature,
    entries: buildOutlineSourceEntries(messages),
    ownerByMessageId: buildOutlineOwnerByMessageId(messages),
  }
  outlineModelCache.set(signature, next)
  if (outlineModelCache.size > OUTLINE_MODEL_CACHE_LIMIT) {
    const oldestKey = outlineModelCache.keys().next().value
    if (oldestKey) outlineModelCache.delete(oldestKey)
  }
  return next
}

function sameStringList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameParts(a: Message['parts'], b: Message['parts']) {
  return a.length === b.length && a.every((part, index) => part === b[index])
}

function sameVisibleEntry(a: VisibleMessageEntry, b: VisibleMessageEntry) {
  return (
    sameStringList(a.sourceIds, b.sourceIds) &&
    a.message.info === b.message.info &&
    a.message.isStreaming === b.message.isStreaming &&
    sameParts(a.message.parts, b.message.parts)
  )
}

function sourceIdsOverlap(a: readonly string[], b: readonly string[]) {
  if (a.length === 0 || b.length === 0) return false
  if (a.length <= b.length) return a.every(id => b.includes(id))
  return b.every(id => a.includes(id))
}

/**
 * 合并 tool 链在 prepend 更老消息后，可见 message.id 可能从链头换成更老的头。
 * 这里沿用旧链的可见 id，避免 DOM key / page 序列被整段打散。
 */
function stabilizeMergedVisibleEntries(
  previous: VisibleMessageEntry[] | undefined,
  next: VisibleMessageEntry[],
): VisibleMessageEntry[] {
  if (!previous?.length) return next

  let changed = false
  const entries = next.map(entry => {
    if (entry.sourceIds.length <= 1) return entry

    const previousEntry = previous.find(
      candidate =>
        candidate.sourceIds.length > 1 &&
        (candidate.message.info.id === entry.message.info.id || sourceIdsOverlap(candidate.sourceIds, entry.sourceIds)),
    )
    if (!previousEntry) return entry
    if (previousEntry.message.info.id === entry.message.info.id) return entry

    changed = true
    return {
      sourceIds: entry.sourceIds,
      message: {
        ...entry.message,
        info: previousEntry.message.info,
        parts: entry.message.parts,
        isStreaming: entry.message.isStreaming,
      },
    }
  })

  return changed ? entries : next
}

function reuseVisibleMessageEntries(
  previous: VisibleMessageEntry[] | undefined,
  next: VisibleMessageEntry[],
): VisibleMessageEntry[] {
  const stabilized = stabilizeMergedVisibleEntries(previous, next)
  if (!previous?.length) return stabilized

  // 按 message id 复用，prepend/append 后旧条目仍可保住引用，避免整表页重建
  const previousById = new Map(previous.map(entry => [entry.message.info.id, entry]))
  let contentChanged = previous.length !== stabilized.length
  const entries = stabilized.map((entry, index) => {
    if (previous[index]?.message.info.id !== entry.message.info.id) contentChanged = true
    const previousEntry = previousById.get(entry.message.info.id)
    if (previousEntry && sameVisibleEntry(previousEntry, entry)) return previousEntry
    contentChanged = true
    return entry
  })
  // 内容都复用了也要检查顺序；顺序变了必须返回新数组，不能直接丢回 previous
  return !contentChanged ? previous : entries
}

function visibleMessagesFromEntries(previous: Message[] | undefined, entries: VisibleMessageEntry[]) {
  const messages = entries.map(entry => entry.message)
  if (
    previous &&
    previous.length === messages.length &&
    previous.every((message, index) => message === messages[index])
  ) {
    return previous
  }
  return messages
}

function sameRow(a: MessageGroupRow, b: MessageGroupRow) {
  return (
    a.key === b.key &&
    a.estimatedHeight === b.estimatedHeight &&
    a.continuesFromPrevious === b.continuesFromPrevious &&
    a.continuesToNext === b.continuesToNext &&
    sameStringList(a.messageIds, b.messageIds) &&
    a.messages.every((message, index) => message === b.messages[index])
  )
}

function reusePageRecords(previous: StableChatPage[] | undefined, next: StableChatPage[]): StableChatPage[] {
  if (!previous) return next
  const previousByKey = new Map(previous.map(page => [page.key, page]))
  let changed = previous.length !== next.length
  const pages = next.map((page, index) => {
    const previousPage = previousByKey.get(page.key)
    if (
      previousPage &&
      previousPage.key === page.key &&
      previousPage.estimatedHeight === page.estimatedHeight &&
      sameStringList(previousPage.messageIds, page.messageIds) &&
      previousPage.rows.length === page.rows.length &&
      previousPage.rows.every((row, rowIndex) => sameRow(row, page.rows[rowIndex]))
    ) {
      if (previous[index] !== previousPage) changed = true
      return previousPage
    }
    changed = true
    return page
  })
  return !changed && previous.length === pages.length ? previous : pages
}

function buildForkTargetIdMap(entries: VisibleMessageEntry[]) {
  return new Map(entries.map(entry => [entry.message.info.id, getVisibleMessageForkTargetId(entry)]))
}

function reuseMap<K, V>(previous: Map<K, V> | undefined, next: Map<K, V>) {
  if (!previous || previous.size !== next.size) return next
  for (const [key, value] of next) {
    if (!previous.has(key) || previous.get(key) !== value) return next
  }
  return previous
}

function reuseSet<T>(previous: Set<T> | undefined, next: Set<T>) {
  if (!previous || previous.size !== next.size) return next
  for (const value of next) {
    if (!previous.has(value)) return next
  }
  return previous
}

export function buildChatPageViewModel(messages: Message[], previous?: ChatPageViewModel): ChatPageViewModel {
  const visibleMessageEntries = reuseVisibleMessageEntries(
    previous?.visibleMessageEntries,
    buildVisibleMessageEntries(messages),
  )
  const visibleMessages = visibleMessagesFromEntries(previous?.visibleMessages, visibleMessageEntries)
  const pageRecords = reusePageRecords(
    previous?.pageRecords,
    reconcileStableChatPages({
      currentPages: previous?.pageRecords ?? [],
      nextMessages: visibleMessages,
      allocateKey: page => page.key,
    }),
  )
  const forkTargetIdMap = reuseMap(previous?.forkTargetIdMap, buildForkTargetIdMap(visibleMessageEntries))
  const outlineModel = getStableOutlineModel(visibleMessages)
  const turnDurationMap = reuseMap(previous?.turnDurationMap, buildTurnDurationMap(messages, visibleMessages))
  const turnLatestAssistantIds = reuseSet(
    previous?.turnLatestAssistantIds,
    buildTurnLatestAssistantIdSet(visibleMessages),
  )

  return {
    visibleMessageEntries,
    visibleMessages,
    pageRecords,
    outlineSourceEntries: outlineModel.entries,
    outlineOwnerByMessageId: outlineModel.ownerByMessageId,
    forkTargetIdMap,
    turnDurationMap,
    turnLatestAssistantIds,
  }
}

export function useChatPageViewModel(messages: Message[]): ChatPageViewModel {
  const previousRef = useRef<ChatPageViewModel | undefined>(undefined)
  return useMemo(() => {
    const viewModel = buildChatPageViewModel(messages, previousRef.current)
    previousRef.current = viewModel
    return viewModel
  }, [messages])
}
