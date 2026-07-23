import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTheme } from '../hooks/useTheme'
import { createSandboxedHtmlDocument } from './htmlSandbox'
import { resolveHtmlPreviewResources } from './htmlPreviewResources'

interface HtmlFilePreviewFrameProps {
  html: string
  title: string
  isResizing?: boolean
  filePath?: string
  directory?: string
}

export function HtmlFilePreviewFrame({
  html,
  title,
  isResizing = false,
  filePath,
  directory,
}: HtmlFilePreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const resourceKey = `${directory ?? ''}\0${filePath ?? ''}\0${html}`
  const [resolution, setResolution] = useState<{ key: string; html: string } | null>(null)
  const resizeId = useId()
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const [initialTheme] = useState<'light' | 'dark'>(theme)
  const effectiveHtml = filePath ? (resolution?.key === resourceKey ? resolution.html : null) : html
  const srcDoc = useMemo(
    () =>
      effectiveHtml &&
      createSandboxedHtmlDocument(effectiveHtml, resizeId, initialTheme, {
        overflow: 'auto',
        allowDataScripts: true,
      }),
    [effectiveHtml, initialTheme, resizeId],
  )

  useEffect(() => {
    if (!filePath) return
    let active = true
    resolveHtmlPreviewResources(html, filePath, directory).then(
      resolved => {
        if (active) setResolution({ key: resourceKey, html: resolved })
      },
      () => {
        if (active) setResolution({ key: resourceKey, html })
      },
    )
    return () => {
      active = false
    }
  }, [directory, filePath, html, resourceKey])

  const sendTheme = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: 'opencode-html-theme', theme }, '*')
  }, [theme])

  useEffect(() => {
    sendTheme()
  }, [sendTheme])

  if (!srcDoc) {
    return (
      <div className="flex h-full items-center justify-center" aria-busy="true">
        <span className="h-4 w-4 animate-spin rounded-full border border-text-400 border-t-transparent" />
      </div>
    )
  }

  // File previews are explicitly opened workspace content; sandboxing isolates them from the app origin.
  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={sendTheme}
      style={{ colorScheme: theme, touchAction: 'pan-x pan-y' }}
      className={`block h-full min-h-0 w-full border-0 bg-transparent ${isResizing ? 'pointer-events-none' : ''}`}
    />
  )
}
