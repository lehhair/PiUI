import { useState, useEffect, useCallback } from 'react'
import { isTauri } from '../utils/tauri'
import { uiErrorHandler } from '../utils'

/**
 * Tauri desktop only: 监听 Rust 侧的 close-requested 事件，
 * 管理关闭确认对话框状态。
 */
export function useCloseServiceDialog() {
  const [showCloseDialog, setShowCloseDialog] = useState(false)

  useEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | undefined

    // 动态 import Tauri event API
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('close-requested', () => {
        setShowCloseDialog(true)
      }).then(fn => {
        unlisten = fn
      })
    })

    return () => {
      unlisten?.()
    }
  }, [])

  const handleCloseDialogConfirm = useCallback(async (stopService: boolean) => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('confirm_close_app', { stopService })
    } catch (e) {
      uiErrorHandler('close app', e)
    }
  }, [])

  const handleCloseDialogCancel = useCallback(() => {
    setShowCloseDialog(false)
  }, [])

  return {
    showCloseDialog,
    handleCloseDialogConfirm,
    handleCloseDialogCancel,
  }
}
