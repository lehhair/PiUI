import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FullscreenViewer } from '../components/FullscreenViewer'
import { FullscreenContext, type FullscreenLayer } from './FullscreenContext.shared'

export function FullscreenProvider({ children }: { children: ReactNode }) {
  const [layer, setLayer] = useState<FullscreenLayer | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const layerRef = useRef<FullscreenLayer | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const openFullscreen = useCallback(
    (nextLayer: FullscreenLayer) => {
      clearCloseTimer()
      setLayer(nextLayer)
      setIsOpen(true)
    },
    [clearCloseTimer],
  )

  const updateFullscreen = useCallback((nextLayer: FullscreenLayer) => {
    setLayer(current => (current?.id === nextLayer.id ? nextLayer : current))
  }, [])

  const closeFullscreen = useCallback(
    (id?: string) => {
      const current = layerRef.current
      if (!current || (id && current.id !== id)) return

      setIsOpen(false)
      clearCloseTimer()
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null
        setLayer(latest => (latest?.id === current.id ? null : latest))
      }, 220)
    },
    [clearCloseTimer],
  )

  const handleClose = useCallback(() => {
    const current = layerRef.current
    if (!current) return
    current.onClose?.()
    closeFullscreen(current.id)
  }, [closeFullscreen])

  useEffect(() => {
    layerRef.current = layer
  }, [layer])

  useEffect(() => clearCloseTimer, [clearCloseTimer])

  const value = useMemo(
    () => ({
      activeId: isOpen ? (layer?.id ?? null) : null,
      openFullscreen,
      updateFullscreen,
      closeFullscreen,
    }),
    [isOpen, layer?.id, openFullscreen, updateFullscreen, closeFullscreen],
  )

  return (
    <FullscreenContext.Provider value={value}>
      {children}
      {layer && (
        <FullscreenViewer
          isOpen={isOpen}
          onClose={handleClose}
          title={layer.title}
          titleExtra={layer.titleExtra}
          headerRight={layer.headerRight}
          showHeader={layer.showHeader}
          zIndex={layer.zIndex}
          deferContent={layer.deferContent}
        >
          {layer.content}
        </FullscreenViewer>
      )}
    </FullscreenContext.Provider>
  )
}
