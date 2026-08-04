import { piBranchStore, piSessionStateStore } from './state/index.js'
import { selectPiTimelineItems } from './selectors/index.js'
import { refreshPiSessionState } from './controllers/index.js'

/**
 * Redo 计划共享 store。
 *
 * pi 的 undo 就是树导航，redo 是纯前端计划：撤销点 + 被裁分支上每个
 * 用户回合的落点 checkpoint。计划在聊天输入区（undo 按钮）和会话树
 * 面板（导航到早期节点）都可能产生，所以收到 store 里跨组件共享，
 * 并用 sessionStorage 持久化（页面刷新后可复活）。
 */
export interface RedoPlan {
  epoch: string
  undoLeafId: string | null
  checkpoints: string[]
  restored: number
}

const STORAGE_PREFIX = 'piui-redo-plan:'

function readStoredPlan(sessionId: string): RedoPlan | null {
  try {
    const raw = window.sessionStorage.getItem(`${STORAGE_PREFIX}${sessionId}`)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<RedoPlan>
    if (typeof value.epoch !== 'string' || !value.epoch) return null
    if (!Array.isArray(value.checkpoints) || value.checkpoints.some(item => typeof item !== 'string')) return null
    const restored = value.restored
    if (typeof restored !== 'number' || !Number.isInteger(restored) || restored < 0 || restored >= value.checkpoints.length) return null
    if (value.undoLeafId !== null && typeof value.undoLeafId !== 'string') return null
    return {
      epoch: value.epoch,
      undoLeafId: value.undoLeafId ?? null,
      checkpoints: value.checkpoints,
      restored,
    }
  } catch {
    return null
  }
}

function persistPlan(sessionId: string, plan: RedoPlan | null): void {
  try {
    const key = `${STORAGE_PREFIX}${sessionId}`
    if (plan) window.sessionStorage.setItem(key, JSON.stringify(plan))
    else window.sessionStorage.removeItem(key)
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

class RedoPlanStore {
  private plans = new Map<string, RedoPlan>()
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getPlan(sessionId: string): RedoPlan | null {
    // 首次读取时从 sessionStorage 复活（页面刷新后内存为空）
    if (!this.plans.has(sessionId)) {
      const stored = readStoredPlan(sessionId)
      if (stored) this.plans.set(sessionId, stored)
    }
    return this.plans.get(sessionId) ?? null
  }

  setPlan(sessionId: string, plan: RedoPlan | null): void {
    const current = this.plans.get(sessionId) ?? null
    if (!plan) this.plans.delete(sessionId)
    else this.plans.set(sessionId, plan)
    persistPlan(sessionId, plan)
    if (current === plan) return
    for (const listener of this.listeners) listener()
  }
}

export const redoPlanStore = new RedoPlanStore()

/**
 * 导航前调用：redo 落点 = 目标之后的后续非 user 节点（pi 的 navigateTree
 * 落在 user 消息上是撤销语义，不能作为 redo 落点；落在非 user 节点时
 * 上面的 user 消息会作为祖先一并恢复）。条数即剩余节点数。
 * 必须在 navigatePiTree 之前读，导航后 branch store 可能已被事件流刷新。
 */
export function captureRedoCheckpoints(sessionId: string, entryId: string): string[] {
  const branch = piBranchStore.getData(sessionId)
  const items = branch ? selectPiTimelineItems(branch) : []
  const undoIndex = items.findIndex(item => item.entryId === entryId)
  if (undoIndex === -1) return []
  return items.slice(undoIndex).filter(item => item.kind !== 'user_message').map(item => item.entryId)
}

/**
 * 导航成功后调用：刷新运行时状态拿到撤销点的真实 leafId，写入计划。
 * checkpoints 为空（无可恢复回合）时清空计划。
 */
export async function commitRedoPlan(sessionId: string, checkpoints: string[]): Promise<void> {
  if (checkpoints.length === 0) {
    redoPlanStore.setPlan(sessionId, null)
    return
  }
  await refreshPiSessionState(sessionId).catch(() => undefined)
  const head = (piSessionStateStore.getState(sessionId)?.head ?? null) as { epoch?: string; leafId?: string } | null
  if (!head?.epoch) {
    redoPlanStore.setPlan(sessionId, null)
    return
  }
  redoPlanStore.setPlan(sessionId, { epoch: head.epoch, undoLeafId: head.leafId ?? null, checkpoints, restored: 0 })
}
