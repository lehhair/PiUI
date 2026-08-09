// ============================================
// ExtensionTuiView - 扩展 TUI 镜像视图
// 用 xterm.js 渲染 worker 端离屏 pi-tui 组件的 ANSI 帧流，
// 并把按键输入回传给 worker 实现交互。
// ============================================

import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { extensionTuiStore } from '../pi/extensionTuiStore'
import {
  sendExtensionTuiInput,
  sendExtensionTuiRedraw,
  sendExtensionTuiResize,
} from '../pi/transport/index.js'

const TUI_FONT_FALLBACK =
  "'Fira Code', 'Noto Sans Mono CJK SC', 'JetBrains Mono', 'Cascadia Code', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"

const TUI_THEME = {
  background: '#00000000',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  cursorAccent: '#1a1a1a',
  selectionBackground: '#4a4540',
  black: '#1a1a1a',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#c9d1d9',
  brightBlack: '#6e7681',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff',
}

/**
 * Renders the offscreen extension TUI for one session. Frames stream through
 * extensionTuiStore.subscribeFrames; keystrokes and resize go back to the
 * worker via session commands.
 */
export function ExtensionTuiView({ sessionId, className }: { sessionId: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new XTerm({
      convertEol: false,
      cursorBlink: false,
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: TUI_FONT_FALLBACK,
      theme: TUI_THEME,
      scrollback: 500,
      allowTransparency: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)

    const unsubscribeFrames = extensionTuiStore.subscribeFrames((frameSessionId, data) => {
      if (frameSessionId === sessionId) term.write(data)
    })

    let disposed = false
    const resize = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      if (disposed) return
      void sendExtensionTuiResize(sessionId, term.cols, term.rows).catch(() => undefined)
    }

    const resizeObserver = new ResizeObserver(() => resize())
    resizeObserver.observe(container)

    const onData = term.onData(data => {
      if (disposed || !data) return
      void sendExtensionTuiInput(sessionId, data).catch(() => undefined)
    })

    // 先让 worker 推一帧完整画面（避免挂载前丢帧导致空白），再按实际尺寸重排。
    void sendExtensionTuiRedraw(sessionId).catch(() => undefined)
    const raf = requestAnimationFrame(() => resize())

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      unsubscribeFrames()
      onData.dispose()
      resizeObserver.disconnect()
      term.dispose()
    }
  }, [sessionId])

  return <div ref={containerRef} className={className} />
}
