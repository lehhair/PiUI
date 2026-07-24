import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { openSearchPanel } from '@codemirror/search'
import { EditorView } from '@codemirror/view'
import type { HighlightTokens } from '../hooks/useSyntaxHighlight'
import {
  clearTargetLine,
  createReadonlyCodeMirrorExtensions,
  dispatchShikiTokens,
  dispatchTargetLine,
  type TargetLineRange,
} from './codeMirrorReadonlyExtensions'
import { getLineCount, getLineNumberColumnWidth } from '../utils/lineNumberUtils'

interface CodeMirrorReadonlyProps {
  code: string
  tokensRef: React.RefObject<HighlightTokens | null>
  tokensVersion: number
  wordWrap: boolean
  lineHeight: number
  maxHeight?: number
  isResizing?: boolean
  isVisible?: boolean
  layoutVersion?: number
  showLineNumbers?: boolean
  className?: string
  extraExtensions?: Extension[]
  targetLine?: number | null
  targetKey?: string
  targetRanges?: readonly TargetLineRange[]
}

const EMPTY_TARGET_RANGES: readonly TargetLineRange[] = []
const EMPTY_EXTENSIONS: Extension[] = []

export function CodeMirrorReadonly({
  code,
  tokensRef,
  tokensVersion,
  wordWrap,
  lineHeight,
  maxHeight,
  isResizing = false,
  isVisible = true,
  layoutVersion = 0,
  showLineNumbers = true,
  className = '',
  extraExtensions = EMPTY_EXTENSIONS,
  targetLine,
  targetKey,
  targetRanges = EMPTY_TARGET_RANGES,
}: CodeMirrorReadonlyProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const constrainedHeight = maxHeight !== undefined
  const lineNumberWidth = useMemo(() => getLineNumberColumnWidth(getLineCount(code)), [code])

  const extensions = useMemo(
    () =>
      createReadonlyCodeMirrorExtensions({
        wordWrap,
        lineHeight,
        showLineNumbers,
        maxHeight,
        editable: !constrainedHeight,
        lineNumberWidth,
        extraExtensions,
      }),
    [wordWrap, lineHeight, showLineNumbers, maxHeight, constrainedHeight, lineNumberWidth, extraExtensions],
  )

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: code, extensions }),
    })

    viewRef.current = view
    dispatchShikiTokens(view, tokensRef.current)

    return () => {
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
  }, [code, extensions, tokensRef])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    dispatchShikiTokens(view, tokensRef.current)
  }, [tokensRef, tokensVersion])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || !isVisible || !targetLine) return

    let disposed = false
    let frameId: number | null = null
    let clearTimerId: number | null = null

    frameId = requestAnimationFrame(() => {
      if (disposed || !view.dom.isConnected) return

      dispatchTargetLine(view, targetLine, targetRanges)
      clearTimerId = window.setTimeout(() => {
        if (!disposed) clearTargetLine(view)
      }, 1600)
    })

    return () => {
      disposed = true
      if (frameId !== null) cancelAnimationFrame(frameId)
      if (clearTimerId !== null) clearTimeout(clearTimerId)
      if (viewRef.current === view) clearTargetLine(view)
    }
  }, [code, isVisible, targetKey, targetLine, targetRanges])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !isVisible) return

    let secondFrameId: number | null = null
    const firstFrameId = requestAnimationFrame(() => {
      view.requestMeasure()
      secondFrameId = requestAnimationFrame(() => view.requestMeasure())
    })
    const transitionTimerId = window.setTimeout(() => view.requestMeasure(), 320)

    return () => {
      cancelAnimationFrame(firstFrameId)
      if (secondFrameId !== null) cancelAnimationFrame(secondFrameId)
      clearTimeout(transitionTimerId)
    }
  }, [isVisible, layoutVersion])

  const handleKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      const view = viewRef.current
      if (!view) return
      event.preventDefault()
      openSearchPanel(view)
    }
  }, [])

  return (
    <div
      className={`${constrainedHeight ? 'w-full overflow-hidden' : 'h-full min-h-0 w-full overflow-hidden'} font-mono text-[length:var(--fs-code)] ${className}`}
      data-resizing={isResizing ? 'true' : undefined}
      onKeyDownCapture={handleKeyDownCapture}
    >
      <div ref={hostRef} className={constrainedHeight ? '' : 'h-full min-h-0'} />
    </div>
  )
}
