import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getInternalDragPreviewElement, getInternalDragSnapshot, subscribeInternalDrag } from '../lib/internalDragCore'

export function InternalDragLayer() {
  const [visible, setVisible] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLElement | null>(null)
  const active = getInternalDragSnapshot().active

  const updateHost = useCallback(() => {
    const host = hostRef.current
    const preview = getInternalDragPreviewElement()
    if (!host) return

    if (previewRef.current !== preview) {
      host.replaceChildren()
      previewRef.current = preview
      if (preview) host.appendChild(preview)
    }

    const activeDrag = getInternalDragSnapshot().active
    if (!activeDrag) {
      host.replaceChildren()
      previewRef.current = null
      return
    }

    const width = Math.min(Math.max(activeDrag.sourceRect.width, 160), 320)
    const leftOffset = Math.min(activeDrag.offset.x, width - 12)
    const topOffset = Math.min(activeDrag.offset.y, Math.max(activeDrag.sourceRect.height, 1) - 6)

    host.style.width = `${width}px`
    host.style.transform = `translate3d(${activeDrag.current.x - leftOffset}px, ${activeDrag.current.y - topOffset}px, 0)`
  }, [])

  useEffect(() => {
    return subscribeInternalDrag(() => {
      const shouldShow = Boolean(getInternalDragSnapshot().active)
      setVisible(current => (current === shouldShow ? current : shouldShow))
      updateHost()
    })
  }, [updateHost])

  useLayoutEffect(() => {
    if (visible) updateHost()
  }, [updateHost, visible])

  if (!visible || !active) return null

  return createPortal(
    <div
      ref={hostRef}
      className="fixed z-[10000] pointer-events-none opacity-80 shadow-lg"
      style={{
        left: 0,
        top: 0,
        willChange: 'transform',
      }}
    />,
    document.body,
  )
}
