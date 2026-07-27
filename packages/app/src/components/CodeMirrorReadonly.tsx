import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state'
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
  readOnly?: boolean
  onChange?: (value: string) => void
}

const EMPTY_TARGET_RANGES: readonly TargetLineRange[] = []
const EMPTY_EXTENSIONS: Extension[] = []
const externalCodeUpdate = Annotation.define<boolean>()

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
  readOnly = true,
  onChange,
}: CodeMirrorReadonlyProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const initialCodeRef = useRef(code)
  const initialTokensRef = useRef(tokensRef.current)
  const initialOnChangeRef = useRef(onChange)
  const changeCompartment = useMemo(() => new Compartment(), [])
  const constrainedHeight = maxHeight !== undefined
  const lineNumberWidth = useMemo(() => getLineNumberColumnWidth(getLineCount(code)), [code])

  useLayoutEffect(() => {
    initialCodeRef.current = code
    initialTokensRef.current = tokensRef.current
    initialOnChangeRef.current = onChange
  }, [code, onChange, tokensRef])

  const extensions = useMemo(
    () =>
      createReadonlyCodeMirrorExtensions({
        wordWrap,
        lineHeight,
        showLineNumbers,
        maxHeight,
        editable: !constrainedHeight,
        readOnly,
        lineNumberWidth,
        extraExtensions,
      }),
    [wordWrap, lineHeight, showLineNumbers, maxHeight, constrainedHeight, lineNumberWidth, extraExtensions, readOnly],
  )

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialCodeRef.current,
        extensions: [extensions, changeCompartment.of(changeListener(initialOnChangeRef.current))],
      }),
    })

    viewRef.current = view
    dispatchShikiTokens(view, initialTokensRef.current)

    return () => {
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
  }, [changeCompartment, extensions])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: changeCompartment.reconfigure(changeListener(onChange)) })
  }, [changeCompartment, onChange])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === code) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: code },
      annotations: externalCodeUpdate.of(true),
    })
  }, [code])

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

function changeListener(onChange: ((value: string) => void) | undefined): Extension {
  return EditorView.updateListener.of(update => {
    if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalCodeUpdate))) {
      onChange?.(update.state.doc.toString())
    }
  })
}
