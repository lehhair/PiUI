import type { PiTimelineItem } from '../pi/domain/index.js'

const FULL_TITLE_MAX = 80

export interface OutlineSourceEntry {
  messageId: string
  title: string
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function itemHasContent(item: PiTimelineItem): boolean {
  if (item.kind === 'user_message') {
    return item.blocks.some(block => block.type === 'text' && block.text.trim().length > 0)
  }
  if (item.kind === 'assistant_message') {
    if (item.message.stopReason === 'error') return true
    return item.blocks.length > 0
  }
  return false
}

export function truncateOutlineLabel(s: string, max: number): string {
  return truncate(s, max)
}

/**
 * 把可见的行 id 解析成"所属区块"（user prompt 条目）的 id 集合：
 * 直接命中条目的保留；助手/工具等行经 ownerByMessageId 映射回它所属的
 * user prompt。这样视口停在助手长文中间（用户 prompt 行不在可见集里）时，
 * 索引窗口仍能定位到当前区块，而不是退化成 slice(-max)。
 */
export function resolveVisibleSectionIds(
  entries: OutlineSourceEntry[],
  visibleIds: string[],
  ownerByMessageId: Map<string, string>,
): string[] {
  const entryIds = new Set(entries.map(entry => entry.messageId))
  const sections = new Set<string>()
  for (const vid of visibleIds) {
    if (entryIds.has(vid)) {
      sections.add(vid)
      continue
    }
    const owner = ownerByMessageId.get(vid)
    if (owner) sections.add(owner)
  }
  return [...sections]
}

/**
 * 从 entries 中找可见区块的索引。
 * 取第一个匹配项——"高亮 = 当前节点上一条（更早）的区块"：
 * 视口跨两个区块时高亮靠前的那一个（正在阅读的上一条回答所在区块），
 * 而不是跳到后一个。
 */
export function findBiasedVisibleIndex(entries: Array<{ messageId: string }>, visibleSectionIds: Set<string>): number {
  if (!visibleSectionIds || visibleSectionIds.size === 0) return -1
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry && visibleSectionIds.has(entry.messageId)) return i
  }
  return -1
}

export function buildOutlineSourceEntries(items: PiTimelineItem[]): OutlineSourceEntry[] {
  const entries: OutlineSourceEntry[] = []
  for (const item of items.filter(itemHasContent)) {
    if (item.kind !== 'user_message') continue
    const raw = item.blocks
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
      .split(/\r?\n/)
      .map(l => l.trim())
      .find(Boolean)
    if (!raw) continue
    const n = normalizeWhitespace(raw)
    entries.push({
      messageId: item.renderKey ?? item.entryId,
      title: truncate(n, FULL_TITLE_MAX),
    })
  }
  return entries
}
