import { useEffect, useId, useRef } from 'react'

const BACK_CLOSE_STATE_KEY = '__opencodeuiBackClose'

interface BackCloseEntry {
  id: string
  onClose: () => void
}

let stack: BackCloseEntry[] = []
let historyEntryActive = false
let ignoreNextPopState = false
let cleanupTimer: number | null = null
let listenerAttached = false

function isBackCloseState(state: unknown): boolean {
  return !!state && typeof state === 'object' && BACK_CLOSE_STATE_KEY in state
}

function clearCleanupTimer() {
  if (cleanupTimer === null) return
  window.clearTimeout(cleanupTimer)
  cleanupTimer = null
}

function pushBackCloseState() {
  if (historyEntryActive) return
  const currentState = window.history.state
  const nextState = currentState && typeof currentState === 'object' ? { ...currentState } : {}
  window.history.pushState({ ...nextState, [BACK_CLOSE_STATE_KEY]: true }, '')
  historyEntryActive = true
}

function closeTopEntry() {
  const entry = stack.at(-1)
  if (!entry) return

  const shouldKeepBackEntry = stack.length > 1
  entry.onClose()

  if (shouldKeepBackEntry) {
    window.setTimeout(() => {
      if (stack.length > 0) pushBackCloseState()
    }, 0)
  }
}

function handlePopState(event: PopStateEvent) {
  if (ignoreNextPopState) {
    ignoreNextPopState = false
    return
  }

  if (isBackCloseState(event.state)) {
    historyEntryActive = true
    return
  }

  historyEntryActive = false
  closeTopEntry()
}

function ensurePopStateListener() {
  if (listenerAttached) return
  window.addEventListener('popstate', handlePopState)
  listenerAttached = true
}

function scheduleHistoryEntryCleanup() {
  clearCleanupTimer()
  cleanupTimer = window.setTimeout(() => {
    cleanupTimer = null
    if (stack.length > 0 || !historyEntryActive || !isBackCloseState(window.history.state)) return

    ignoreNextPopState = true
    historyEntryActive = false
    window.history.back()
  }, 0)
}

export function useBackClose(isOpen: boolean, onClose: () => void) {
  const id = useId()
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!isOpen) return

    clearCleanupTimer()
    ensurePopStateListener()
    stack = stack.filter(entry => entry.id !== id)
    stack.push({ id, onClose: () => onCloseRef.current() })
    pushBackCloseState()

    return () => {
      stack = stack.filter(entry => entry.id !== id)
      if (stack.length === 0) scheduleHistoryEntryCleanup()
    }
  }, [id, isOpen])
}
