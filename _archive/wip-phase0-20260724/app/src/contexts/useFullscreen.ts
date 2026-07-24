import { useCallback, useContext, useEffect } from 'react'
import { FullscreenContext, type FullscreenContextValue, type FullscreenLayer } from './FullscreenContext.shared'

export function useFullscreen(): FullscreenContextValue {
  const context = useContext(FullscreenContext)
  if (!context) {
    throw new Error('useFullscreen must be used within FullscreenProvider')
  }
  return context
}

export function useFullscreenLayer(layer: FullscreenLayer | null) {
  const { activeId, openFullscreen, updateFullscreen, closeFullscreen } = useFullscreen()
  const isOpen = !!layer && activeId === layer.id

  useEffect(() => {
    if (!isOpen || !layer) return
    updateFullscreen(layer)
  }, [isOpen, layer, updateFullscreen])

  const open = useCallback(() => {
    if (!layer) return
    openFullscreen(layer)
  }, [layer, openFullscreen])

  const close = useCallback(() => {
    if (!layer) return
    closeFullscreen(layer.id)
  }, [layer, closeFullscreen])

  return { isOpen, open, close }
}
