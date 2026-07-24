import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISCLOSURE_SCROLL_LOCK_MS,
  findChatScrollRoot,
  isScrollAnchorLocked,
  lockScrollAroundAnchor,
  resetScrollAnchorLocksForTests,
} from './scrollUtils'

type MockScrollRoot = HTMLDivElement & {
  _scrollTop: number
  _headerTop: number
}

function createMockRoot(): { root: MockScrollRoot; block: HTMLDivElement; header: HTMLButtonElement } {
  const root = document.createElement('div') as MockScrollRoot
  root.dataset.chatScrollRoot = 'true'
  root._scrollTop = -100
  root._headerTop = 200
  Object.defineProperty(root, 'scrollTop', {
    configurable: true,
    get() {
      return root._scrollTop
    },
    set(value: number) {
      const delta = value - root._scrollTop
      root._scrollTop = value
      root._headerTop -= delta
    },
  })

  const block = document.createElement('div')
  const header = document.createElement('button')
  block.appendChild(header)
  root.appendChild(block)
  document.body.appendChild(root)

  const rootTop = 0
  vi.spyOn(root, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        top: rootTop,
        bottom: 800,
        left: 0,
        right: 400,
        width: 400,
        height: 800,
        x: 0,
        y: rootTop,
        toJSON: () => ({}),
      }) as DOMRect,
  )
  vi.spyOn(header, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        top: root._headerTop,
        bottom: root._headerTop + 24,
        left: 0,
        right: 400,
        width: 400,
        height: 24,
        x: 0,
        y: root._headerTop,
        toJSON: () => ({}),
      }) as DOMRect,
  )

  return { root, block, header }
}

function flushRafFrames(count: number): Promise<void> {
  return new Promise(resolve => {
    const step = (left: number) => {
      if (left <= 0) {
        resolve()
        return
      }
      requestAnimationFrame(() => step(left - 1))
    }
    step(count)
  })
}

describe('findChatScrollRoot', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('finds the nearest chat scroll root', () => {
    const root = document.createElement('div')
    root.dataset.chatScrollRoot = 'true'
    const anchor = document.createElement('button')
    root.appendChild(anchor)
    document.body.appendChild(root)

    expect(findChatScrollRoot(anchor)).toBe(root)
  })

  it('does not fall back to unrelated overflow-y-auto containers', () => {
    const outer = document.createElement('div')
    outer.className = 'overflow-y-auto'
    const anchor = document.createElement('button')
    outer.appendChild(anchor)
    document.body.appendChild(outer)

    expect(findChatScrollRoot(anchor)).toBeNull()
  })
})

describe('lockScrollAroundAnchor', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.useRealTimers()
    resetScrollAnchorLocksForTests()
  })

  it('compensates scrollTop when the anchor drifts after height change', async () => {
    const { root, block, header } = createMockRoot()
    expect(isScrollAnchorLocked()).toBe(false)

    const unlock = lockScrollAroundAnchor(header, { observe: block, durationMs: 200 })
    expect(isScrollAnchorLocked()).toBe(true)

    // 高度向下生长时，col-reverse 会把 header 顶上去
    root._headerTop = 120
    await flushRafFrames(2)

    // delta = 120 - 200 = -80 → scrollTop -100 + -80 = -180，header 回到 200
    expect(root.scrollTop).toBe(-180)
    expect(root._headerTop).toBe(200)

    unlock()
    expect(isScrollAnchorLocked()).toBe(false)
  })

  it('releases the lock when the user scrolls', async () => {
    const { root, block, header } = createMockRoot()
    const unlock = lockScrollAroundAnchor(header, { observe: block, durationMs: DISCLOSURE_SCROLL_LOCK_MS })
    expect(isScrollAnchorLocked()).toBe(true)

    root.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    expect(isScrollAnchorLocked()).toBe(false)

    root._headerTop = 120
    await flushRafFrames(2)
    expect(root.scrollTop).toBe(-100)

    unlock()
  })

  it('auto-stops after durationMs', async () => {
    vi.useFakeTimers()
    const { block, header } = createMockRoot()
    const unlock = lockScrollAroundAnchor(header, { observe: block, durationMs: 40 })
    expect(isScrollAnchorLocked()).toBe(true)

    await vi.advanceTimersByTimeAsync(40)
    expect(isScrollAnchorLocked()).toBe(false)

    unlock()
    vi.useRealTimers()
  })

  it('tracks active locks across concurrent anchors', () => {
    const first = createMockRoot()
    const second = createMockRoot()
    const unlockA = lockScrollAroundAnchor(first.header, { observe: first.block, durationMs: 5000 })
    const unlockB = lockScrollAroundAnchor(second.header, { observe: second.block, durationMs: 5000 })
    expect(isScrollAnchorLocked()).toBe(true)

    unlockA()
    expect(isScrollAnchorLocked()).toBe(true)

    unlockB()
    expect(isScrollAnchorLocked()).toBe(false)
  })

  it('does not release on pre-animation stable frames', async () => {
    const { block, header } = createMockRoot()
    lockScrollAroundAnchor(header, { observe: block, durationMs: 5000 })
    expect(isScrollAnchorLocked()).toBe(true)

    // 动画还没开始，位置一直稳；不应提前松手
    await flushRafFrames(6)
    expect(isScrollAnchorLocked()).toBe(true)
  })
})
