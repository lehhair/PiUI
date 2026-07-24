import { useState, useRef, useEffect, useCallback } from 'react'

// ============================================
// useAttachmentRail
// 附件横向轨道的滚动/溢出/渐变遮罩逻辑
// ============================================

interface UseAttachmentRailOptions {
  /** 附件数组长度，用于检测新增附件时自动滚到末尾 */
  attachmentCount: number
  /** 附件轨道容器 ref */
  railRef: React.RefObject<HTMLDivElement | null>
}

interface UseAttachmentRailReturn {
  /** 轨道内容是否超出容器宽度 */
  overflowing: boolean
  /** 是否显示左侧渐变遮罩 */
  showLeftFade: boolean
  /** 是否显示右侧渐变遮罩 */
  showRightFade: boolean
  /** 同步轨道滚动状态（绑定到 onScroll） */
  handleScroll: () => void
  /** 拦截纵向滚轮为横向滚动（绑定到 onWheel） */
  handleWheel: (e: React.WheelEvent<HTMLDivElement>) => void
}

export function useAttachmentRail({ attachmentCount, railRef }: UseAttachmentRailOptions): UseAttachmentRailReturn {
  const [overflowing, setOverflowing] = useState(false)
  const [showLeftFade, setShowLeftFade] = useState(false)
  const [showRightFade, setShowRightFade] = useState(false)
  const prevCountRef = useRef(0)

  const syncState = useCallback(() => {
    const el = railRef.current
    if (!el) {
      setOverflowing(false)
      setShowLeftFade(false)
      setShowRightFade(false)
      return
    }

    const nextOverflow = el.scrollWidth > el.clientWidth + 1
    const nextLeftFade = nextOverflow && el.scrollLeft > 2
    const nextRightFade = nextOverflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 2

    setOverflowing(prev => (prev === nextOverflow ? prev : nextOverflow))
    setShowLeftFade(prev => (prev === nextLeftFade ? prev : nextLeftFade))
    setShowRightFade(prev => (prev === nextRightFade ? prev : nextRightFade))
  }, [railRef])

  const resetState = useCallback(() => {
    setOverflowing(false)
    setShowLeftFade(false)
    setShowRightFade(false)
  }, [])

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const el = railRef.current
      if (!el) return

      const maxScrollLeft = el.scrollWidth - el.clientWidth
      if (maxScrollLeft <= 1) return

      const dominantDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (Math.abs(dominantDelta) < 0.5) return

      const nextScrollLeft = Math.max(0, Math.min(el.scrollLeft + dominantDelta, maxScrollLeft))
      if (Math.abs(nextScrollLeft - el.scrollLeft) < 1) return

      e.preventDefault()
      el.scrollLeft = nextScrollLeft
      syncState()
    },
    [railRef, syncState],
  )

  // 附件数量变化时：自动滚到末尾 + 同步状态；清空时重置
  useEffect(() => {
    const el = railRef.current

    if (!el || attachmentCount === 0) {
      prevCountRef.current = 0
      const frameId = requestAnimationFrame(() => resetState())
      return () => cancelAnimationFrame(frameId)
    }

    const frameId = requestAnimationFrame(() => {
      const increased = attachmentCount > prevCountRef.current
      if (increased) {
        const nextLeft = el.scrollWidth
        if (typeof el.scrollTo === 'function') {
          el.scrollTo({
            left: nextLeft,
            behavior: prevCountRef.current === 0 ? 'auto' : 'smooth',
          })
        } else {
          el.scrollLeft = nextLeft
        }
      }
      syncState()
      prevCountRef.current = attachmentCount
    })

    const measure = () => syncState()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild instanceof HTMLElement) {
      ro.observe(el.firstElementChild)
    }
    window.addEventListener('resize', measure)

    return () => {
      cancelAnimationFrame(frameId)
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [attachmentCount, railRef, resetState, syncState])

  return {
    overflowing,
    showLeftFade,
    showRightFade,
    handleScroll: syncState,
    handleWheel,
  }
}
