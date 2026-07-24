/**
 * 把列表项滚动到容器可视区域内，确保完全可见。
 *
 * 比 `element.scrollIntoView({ block: 'nearest' })` 更可靠：
 * 后者在有 padding 的容器上、部分可见时只滚最小距离，
 * 会导致选中项"卡在半边"。这里直接基于 getBoundingClientRect 计算，
 * 确保选中项完全在容器的 padding box（可视内容区）内。
 */
export function scrollItemIntoView(container: HTMLElement, item: HTMLElement): void {
  const cStyle = getComputedStyle(container)
  const paddingTop = parseFloat(cStyle.paddingTop) || 0
  const paddingBottom = parseFloat(cStyle.paddingBottom) || 0

  const cRect = container.getBoundingClientRect()
  // 可视内容区 = border box 内缩 padding
  const contentTop = cRect.top + paddingTop
  const contentBottom = cRect.bottom - paddingBottom

  const iRect = item.getBoundingClientRect()

  const offsetTop = iRect.top - contentTop
  const offsetBottom = iRect.bottom - contentBottom

  if (offsetTop < 0) {
    container.scrollTop += offsetTop
  } else if (offsetBottom > 0) {
    container.scrollTop += offsetBottom
  }
}

/** grid-rows 展开动画约 300ms + delayed render 余量；稳定后可提前结束 */
export const DISCLOSURE_SCROLL_LOCK_MS = 480
const STABLE_FRAMES_TO_RELEASE = 3
const RESTORE_EPSILON_PX = 0.5

const activeLocks = new Set<() => void>()

/** 是否有展开/收起滚动锁在跑（ChatArea 页高锚点应让路） */
export function isScrollAnchorLocked(): boolean {
  return activeLocks.size > 0
}

/** 仅测试用：清掉残留锁 */
export function resetScrollAnchorLocksForTests(): void {
  for (const stop of [...activeLocks]) stop()
  activeLocks.clear()
}

export function findChatScrollRoot(from: Element | null): HTMLElement | null {
  if (!from) return null
  return from.closest('[data-chat-scroll-root="true"]') as HTMLElement | null
}

export interface LockScrollAroundAnchorOptions {
  /** 观察高度变化的节点；默认 anchor 父节点 */
  observe?: Element | null
  /** 最长锁定时间；高度稳定会提前结束 */
  durationMs?: number
}

/**
 * 展开/收起时把锚点（通常是折叠 header）钉在视口原位置。
 *
 * 内容仍按正常文档流生长，不改 position。
 * 聊天流是 flex-col-reverse，高度变化会默认钉底部，这里只补偿 scrollTop。
 * ResizeObserver 跟高度；出现过漂移后，高度连续稳定若干帧再松手；用户手滚立刻松手。
 */
export function lockScrollAroundAnchor(
  anchor: HTMLElement | null,
  options?: LockScrollAroundAnchorOptions,
): () => void {
  if (!anchor) return () => undefined

  const maybeRoot = findChatScrollRoot(anchor)
  if (!maybeRoot) return () => undefined
  const root: HTMLElement = maybeRoot

  const measureRootTop = () => root.getBoundingClientRect().top
  const targetTop = anchor.getBoundingClientRect().top - measureRootTop()
  const observeTarget = options?.observe ?? anchor.parentElement ?? anchor
  const durationMs = options?.durationMs ?? DISCLOSURE_SCROLL_LOCK_MS

  let stopped = false
  let applyingRestore = false
  let sawDrift = false
  let raf1 = 0
  let raf2 = 0
  let clearApplyingRaf = 0
  let endTimer = 0
  let stableFrames = 0
  let ro: ResizeObserver | null = null

  const stop = () => {
    if (stopped) return
    stopped = true
    activeLocks.delete(stop)
    ro?.disconnect()
    ro = null
    if (raf1) cancelAnimationFrame(raf1)
    if (raf2) cancelAnimationFrame(raf2)
    if (clearApplyingRaf) cancelAnimationFrame(clearApplyingRaf)
    if (endTimer) window.clearTimeout(endTimer)
    root.removeEventListener('wheel', onUserScrollIntent)
    root.removeEventListener('touchmove', onUserScrollIntent)
    root.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('keydown', onKeyDown)
  }

  activeLocks.add(stop)

  const restore = () => {
    if (stopped) return
    const nextTop = anchor.getBoundingClientRect().top - measureRootTop()
    const delta = nextTop - targetTop
    if (Math.abs(delta) < RESTORE_EPSILON_PX) {
      // 动画开始前的静止帧不算稳定；必须先见过漂移，再连稳才松手
      if (!sawDrift) return
      stableFrames += 1
      if (stableFrames >= STABLE_FRAMES_TO_RELEASE) stop()
      return
    }
    sawDrift = true
    stableFrames = 0
    applyingRestore = true
    root.scrollTop += delta
    if (clearApplyingRaf) cancelAnimationFrame(clearApplyingRaf)
    clearApplyingRaf = requestAnimationFrame(() => {
      clearApplyingRaf = 0
      applyingRestore = false
    })
  }

  const onUserScrollIntent = () => {
    if (stopped || applyingRestore) return
    stop()
  }

  const onPointerDown = (event: PointerEvent) => {
    if (stopped || applyingRestore) return
    // 点滚动条时松手，避免和用户拖拽抢 scrollTop
    const rect = root.getBoundingClientRect()
    if (event.clientX >= rect.right - 24) stop()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (stopped || applyingRestore) return
    switch (event.key) {
      case 'PageUp':
      case 'PageDown':
      case 'Home':
      case 'End':
      case 'ArrowUp':
      case 'ArrowDown':
      case ' ':
        stop()
        break
      default:
        break
    }
  }

  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      restore()
    })
    ro.observe(observeTarget)
  }

  // 首帧布局（React commit 后）立刻补一次，避免动画开始前闪一下
  raf1 = requestAnimationFrame(() => {
    raf1 = 0
    restore()
    raf2 = requestAnimationFrame(() => {
      raf2 = 0
      restore()
    })
  })

  endTimer = window.setTimeout(() => {
    endTimer = 0
    stop()
  }, durationMs)

  root.addEventListener('wheel', onUserScrollIntent, { passive: true })
  root.addEventListener('touchmove', onUserScrollIntent, { passive: true })
  root.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('keydown', onKeyDown)

  return stop
}
