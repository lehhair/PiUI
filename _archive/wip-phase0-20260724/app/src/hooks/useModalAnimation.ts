import { useState, useEffect } from 'react'
import { useDelayedRender } from './useDelayedRender'
import { useBackClose } from './useBackClose'

/**
 * useModalAnimation - modal 打开/关闭动画逻辑
 *
 * 通过 requestAnimationFrame 触发 visibility 动画，
 * 结合 useDelayedRender 控制 mount/unmount 过渡。
 * 同时处理 ESC 关闭和系统返回键关闭。
 */
export function useModalAnimation(isOpen: boolean, onClose: () => void, delayMs = 200) {
  const [isVisible, setIsVisible] = useState(false)
  const shouldRender = useDelayedRender(isOpen, delayMs)

  // Animate visibility via rAF
  useEffect(() => {
    let frameId: number | null = null

    if (shouldRender && isOpen) {
      frameId = requestAnimationFrame(() => setIsVisible(true))
    } else {
      frameId = requestAnimationFrame(() => setIsVisible(false))
    }

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
    }
  }, [shouldRender, isOpen])

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  useBackClose(isOpen, onClose)

  return { isVisible, shouldRender }
}
