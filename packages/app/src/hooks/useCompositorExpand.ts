import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { EXPAND_MOTION } from '../constants/expandMotion'

function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
}

const DURATION_MS = 260
const EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
/** @deprecated 用 EXPAND_MOTION.gridTransition；保留导出兼容旧 import */
export const COMPOSITOR_GRID_TRANSITION = EXPAND_MOTION.gridTransition

/**
 * Android expand blank fix:
 * - Expand: instant layout open (paint-safe), visual height via max-height on DOM.
 * - Collapse: original grid-rows transition (content already painted).
 * - Desktop: original grid-rows both ways.
 */
export function useCompositorExpand(open: boolean) {
  const enabled = isAndroid()
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [layoutOpen, setLayoutOpen] = useState(open)
  const [useGridTransition, setUseGridTransition] = useState(!enabled)
  const [keepAnimating, setKeepAnimating] = useState(false)
  const genRef = useRef(0)
  const prevOpenRef = useRef(open)

  useLayoutEffect(() => {
    if (!enabled) {
      // 非 Android：下列 state 在渲染期已由派生值直接覆盖（见函数末尾分支），
      // 无需同步 setState，只同步 ref 与清理展开样式
      prevOpenRef.current = open
      clearExpandStyles(contentRef.current)
      return
    }

    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (wasOpen === open) return

    const gen = ++genRef.current
    const timers: number[] = []
    const rafs: number[] = []

    // 展开/收起是 layout effect 驱动的动画状态机：必须与 open 变化同帧同步 setState
    /* eslint-disable react-hooks/set-state-in-effect */
    if (open) {
      setUseGridTransition(false)
      setKeepAnimating(true)
      setLayoutOpen(true)

      rafs.push(
        requestAnimationFrame(() => {
          if (gen !== genRef.current) return
          const el = contentRef.current
          if (!el) {
            setKeepAnimating(false)
            return
          }

          el.style.transition = 'none'
          el.style.overflow = 'hidden'
          el.style.maxHeight = '0px'
          void el.offsetHeight
          const full = Math.max(el.scrollHeight, 1)

          el.style.transition = `max-height ${DURATION_MS}ms ${EASING}`
          rafs.push(
            requestAnimationFrame(() => {
              if (gen !== genRef.current) return
              el.style.maxHeight = `${full}px`
              timers.push(
                window.setTimeout(() => {
                  if (gen !== genRef.current) return
                  clearExpandStyles(el)
                  setKeepAnimating(false)
                }, DURATION_MS + 24),
              )
            }),
          )
        }),
      )

      return () => {
        rafs.forEach(id => cancelAnimationFrame(id))
        timers.forEach(id => window.clearTimeout(id))
      }
    }

    // Collapse: drop fake styles, use original grid-rows.
    clearExpandStyles(contentRef.current)
    setKeepAnimating(false)
    setUseGridTransition(true)
    setLayoutOpen(false)

    return () => {
      rafs.forEach(id => cancelAnimationFrame(id))
      timers.forEach(id => window.clearTimeout(id))
    }
  }, [enabled, open])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!enabled) {
    return {
      contentRef: contentRef as RefObject<HTMLDivElement | null>,
      layoutOpen: open,
      keepMounted: open,
      panelClassName: COMPOSITOR_GRID_TRANSITION,
    }
  }

  return {
    contentRef: contentRef as RefObject<HTMLDivElement | null>,
    layoutOpen,
    keepMounted: open || layoutOpen || keepAnimating,
    panelClassName: useGridTransition ? COMPOSITOR_GRID_TRANSITION : '',
  }
}

function clearExpandStyles(el: HTMLDivElement | null) {
  if (!el) return
  el.style.transition = 'none'
  el.style.maxHeight = ''
  el.style.overflow = ''
}
