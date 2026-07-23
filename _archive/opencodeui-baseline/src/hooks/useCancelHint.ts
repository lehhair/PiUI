import { useRef, useState, useEffect, useCallback } from 'react'

/**
 * Double-Esc 取消交互：第一次按 Esc 显示提示，
 * 600ms 内再按一次才真正取消 streaming。
 */
export function useCancelHint(isStreaming: boolean, handleAbort: () => void) {
  const [showCancelHint, setShowCancelHint] = useState(false)
  const lastEscTimeRef = useRef(0)
  const escHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // streaming 结束时清理 — 这是合理的"根据 prop 变化重置 state"模式
  useEffect(() => {
    if (!isStreaming) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 重置 UI 状态响应 prop 变化
      setShowCancelHint(false)
      lastEscTimeRef.current = 0
      if (escHintTimerRef.current) {
        clearTimeout(escHintTimerRef.current)
        escHintTimerRef.current = null
      }
    }
  }, [isStreaming])

  const handleCancelMessage = useCallback(() => {
    if (!isStreaming) return

    const now = Date.now()
    const elapsed = now - lastEscTimeRef.current

    if (elapsed < 600) {
      // 双击确认 → 真正取消
      lastEscTimeRef.current = 0
      setShowCancelHint(false)
      if (escHintTimerRef.current) clearTimeout(escHintTimerRef.current)
      handleAbort()
    } else {
      // 第一次按 → 显示提示
      lastEscTimeRef.current = now
      setShowCancelHint(true)
      if (escHintTimerRef.current) clearTimeout(escHintTimerRef.current)
      escHintTimerRef.current = setTimeout(() => {
        setShowCancelHint(false)
        lastEscTimeRef.current = 0
      }, 1500)
    }
  }, [isStreaming, handleAbort])

  return { showCancelHint, handleCancelMessage }
}
