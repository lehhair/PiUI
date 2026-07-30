import type { PiAssistantMessageItem, PiTimelineItem } from '../../pi/domain/index.js'

/**
 * Chat timeline visibility: filters items without renderable content and
 * merges trailing tool-only assistant items into the preceding one, so a
 * tool call chain renders as one continuous message.
 */

function itemHasContent(item: PiTimelineItem): boolean {
  if (item.kind === 'user_message') {
    return item.blocks.some(block => block.type === 'text' ? block.text.trim().length > 0 : true)
  }
  if (item.kind === 'assistant_message') {
    const hasRenderable = item.blocks.some(block =>
      block.type === 'text'
        ? block.text.trim().length > 0
        : block.type === 'thinking'
          ? block.thinking.trim().length > 0
          : true,
    )
    // 有非 abort 错误的助手消息始终可见（展示错误信息）。
    // abort 只有在已经产生可见内容时才显示；空 abort 不占信息流位置。
    if (item.message.stopReason === 'error') return true
    if (item.message.stopReason === 'aborted') return hasRenderable
    return hasRenderable
  }
  // bash/compaction/summary/custom/label/unknown 等系统条目始终保留（不静默丢弃）
  return true
}

function endsWithTool(item: PiTimelineItem): boolean {
  if (item.kind !== 'assistant_message' || item.blocks.length === 0) return false
  for (let i = item.blocks.length - 1; i >= 0; i--) {
    const block = item.blocks[i]
    // skip empty thinking / empty text — they carry no visible content
    if (block.type === 'thinking' && block.thinking.trim().length === 0) continue
    if (block.type === 'text' && block.text.trim().length === 0) continue
    return block.type === 'toolCall'
  }
  return false
}

function isToolOnlyFollowUp(item: PiTimelineItem): boolean {
  if (item.kind !== 'assistant_message') return false
  let sawTool = false
  for (const block of item.blocks) {
    if (block.type === 'thinking' && block.thinking.trim().length > 0) return false
    if (block.type === 'text' && block.text.trim().length > 0) return false
    if (block.type === 'toolCall') sawTool = true
  }
  return sawTool
}

function isMergeableTrailing(item: PiTimelineItem): boolean {
  if (item.kind !== 'assistant_message') return false
  let sawTool = false
  let sawVisibleText = false
  for (const block of item.blocks) {
    if (block.type === 'thinking' && block.thinking.trim().length > 0) return false
    if (block.type === 'toolCall') {
      sawTool = true
      continue
    }
    if (block.type === 'text' && block.text.trim().length > 0) {
      sawVisibleText = true
      continue
    }
  }
  return sawTool && sawVisibleText
}

export interface VisibleTimelineEntry {
  item: PiTimelineItem
  sourceIds: string[]
}

export function getVisibleTimelineForkTargetId(entry: VisibleTimelineEntry): string {
  return entry.sourceIds[entry.sourceIds.length - 1] || entry.item.entryId
}

export function buildVisibleTimelineEntries(items: PiTimelineItem[]): VisibleTimelineEntry[] {
  // 防御性去重：保证输入无重复 ID
  const seenIds = new Set<string>()
  const unique: PiTimelineItem[] = []
  for (const item of items) {
    if (!seenIds.has(item.entryId)) {
      seenIds.add(item.entryId)
      unique.push(item)
    }
  }
  const filtered = unique.filter(itemHasContent)
  const result: VisibleTimelineEntry[] = []

  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i]
    if (!endsWithTool(item)) {
      result.push({ item, sourceIds: [item.entryId] })
      continue
    }

    const sourceIds = [item.entryId]
    let j = i + 1

    while (j < filtered.length) {
      if (isToolOnlyFollowUp(filtered[j])) {
        sourceIds.push(filtered[j].entryId)
        j++
      } else if (isMergeableTrailing(filtered[j])) {
        sourceIds.push(filtered[j].entryId)
        j++
        // 如果该消息也以 tool 结尾（text 在 tool 前面，是中间说明不是结论），
        // 继续合并链；只有 text 在 tool 后面（真正收尾）才终止
        if (!endsWithTool(filtered[j - 1])) break
      } else {
        break
      }
    }

    if (j === i + 1) {
      result.push({ item, sourceIds })
    } else {
      const mergedItems = filtered.slice(i + 1, j) as PiAssistantMessageItem[]
      const first = item as PiAssistantMessageItem
      const last = mergedItems[mergedItems.length - 1]
      const merged: PiAssistantMessageItem = {
        ...first,
        // message 取最后一条（最新模型状态/stopReason）
        message: last.message,
        blocks: [...first.blocks, ...mergedItems.flatMap(m => m.blocks)],
        toolResults: Object.assign({}, first.toolResults, ...mergedItems.map(m => m.toolResults)),
      }
      result.push({ item: merged, sourceIds })
      i = j - 1
    }
  }

  return result
}
