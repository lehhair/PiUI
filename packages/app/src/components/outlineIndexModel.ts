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
