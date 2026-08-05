import { useCallback, useEffect, useState } from 'react'
import { isTauri, isTauriMobile } from '../utils/tauri'
import { uiErrorHandler } from '../utils'

export function useCloseServiceDialog() {
  const [showCloseDialog, setShowCloseDialog] = useState(false)

  useEffect(() => {
    if (!isTauri() || isTauriMobile()) return
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event').then(({ listen }) => {
      void listen('close-requested', () => setShowCloseDialog(true)).then(stop => {
        unlisten = stop
      })
    })
    return () => unlisten?.()
  }, [])

  const confirmClose = useCallback(async (stopService: boolean) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('confirm_close_app', { stopService })
    } catch (error) {
      uiErrorHandler('close app', error)
      throw error
    }
  }, [])

  const cancelClose = useCallback(() => setShowCloseDialog(false), [])
  return { showCloseDialog, confirmClose, cancelClose }
}
