/** 与消息入场生长动画一致（motion duration 0.2s） */
export const ENTRY_GROW_DURATION_MS = 200
/** 超过此时长的消息不再播入场生长 */
export const ENTRY_GROW_MAX_AGE_MS = 3000
/** 完成集合上限，防止长会话无限增长 */
const COMPLETED_ID_LIMIT = 256

/** 插入序：靠前的先淘汰 */
const completedIds = new Set<string>()

export function isEntryGrowComplete(id: string): boolean {
  return completedIds.has(id)
}

export function markEntryGrowComplete(id: string): void {
  if (completedIds.has(id)) {
    // 刷新插入序：移到末尾
    completedIds.delete(id)
    completedIds.add(id)
    return
  }
  completedIds.add(id)
  while (completedIds.size > COMPLETED_ID_LIMIT) {
    const oldest = completedIds.values().next().value
    if (oldest == null) break
    completedIds.delete(oldest)
  }
}

export function shouldPlayEntryGrow(created: number, now = Date.now()): boolean {
  return now - created <= ENTRY_GROW_MAX_AGE_MS
}

/** 仅测试用 */
export function resetEntryGrowCompletionsForTests(): void {
  completedIds.clear()
}
