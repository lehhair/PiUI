import { createContext, type ReactNode } from 'react'
import type { FullscreenViewerProps } from '../components/FullscreenViewer'

export interface FullscreenLayer {
  id: string
  content: ReactNode
  title?: FullscreenViewerProps['title']
  titleExtra?: FullscreenViewerProps['titleExtra']
  headerRight?: FullscreenViewerProps['headerRight']
  showHeader?: FullscreenViewerProps['showHeader']
  zIndex?: FullscreenViewerProps['zIndex']
  deferContent?: FullscreenViewerProps['deferContent']
  onClose?: () => void
}

export interface FullscreenContextValue {
  activeId: string | null
  openFullscreen: (layer: FullscreenLayer) => void
  updateFullscreen: (layer: FullscreenLayer) => void
  closeFullscreen: (id?: string) => void
}

export const FullscreenContext = createContext<FullscreenContextValue | null>(null)
