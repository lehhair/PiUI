import { useEffect, useRef, useState, type RefObject } from 'react'
import { resolveDropZone } from './PaneDropOverlay'
import {
  getDroppedPathsInfo,
  getTauriDropClientPoints,
  subscribeTauriDragDrop,
  type TauriDragDropEvent,
  type TauriDropPosition,
} from '../../lib/tauriDragDrop'

function isOverInput(pane: HTMLElement, clientX: number, clientY: number): boolean {
  const input = pane.querySelector<HTMLElement>('[data-input-box]')
  if (!input) return false
  const ir = input.getBoundingClientRect()
  return clientX >= ir.left && clientX <= ir.right && clientY >= ir.top && clientY <= ir.bottom
}

/** 与 session drop 的 center 区同一判定 */
function isInProjectDropZone(pane: HTMLElement, clientX: number, clientY: number): boolean {
  const rect = pane.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return false
  }
  if (isOverInput(pane, clientX, clientY)) return false
  const xRel = (clientX - rect.left) / rect.width
  const yRel = (clientY - rect.top) / rect.height
  return resolveDropZone({ xRel, yRel }) === 'center'
}

function isTauriInProjectDropZone(pane: HTMLElement, position: TauriDropPosition): boolean {
  return getTauriDropClientPoints(position).some(({ x, y }) => isInProjectDropZone(pane, x, y))
}

/**
 * 拖到 pane 正中心时显示「添加为项目」。
 * - UI：任意拖拽都可触发（浏览器 HTML5 也能测）
 * - 实际添加：仅 Tauri 且路径是文件夹；输入框区域让给附件
 */
export function useFolderProjectDrop(
  paneRootRef: RefObject<HTMLElement | null>,
  addDirectory: (path: string) => void,
): boolean {
  const [isActive, setIsActive] = useState(false)
  const pathsRef = useRef<string[] | null>(null)
  const addDirectoryRef = useRef(addDirectory)
  addDirectoryRef.current = addDirectory
  const lastTauriDropAtRef = useRef(0)

  useEffect(() => {
    let alive = true
    const setActive = (next: boolean) => {
      if (alive) setIsActive(next)
    }

    const unlistenTauri = subscribeTauriDragDrop((event: TauriDragDropEvent) => {
      const pane = paneRootRef.current
      if (event.type === 'leave') {
        pathsRef.current = null
        setActive(false)
        return
      }

      if (event.type === 'enter' || event.type === 'drop') {
        pathsRef.current = event.paths
      }

      if (!pane) {
        setActive(false)
        return
      }

      const inZone = isTauriInProjectDropZone(pane, event.position)
      if (event.type === 'enter' || event.type === 'over') {
        setActive(inZone)
        return
      }

      setActive(false)
      const paths = event.paths.length > 0 ? event.paths : pathsRef.current
      pathsRef.current = null
      if (!inZone || !paths || paths.length === 0) return

      lastTauriDropAtRef.current = Date.now()
      void getDroppedPathsInfo(paths)
        .then(items => {
          if (!alive) return
          for (const item of items) {
            if (item.type === 'folder') addDirectoryRef.current(item.path)
          }
        })
        .catch(err => {
          console.warn('[useFolderProjectDrop] Failed to add dropped folders:', err)
        })
    })

    // capture：输入框 stopPropagation 后 bubble 收不到，capture 仍能更新 UI
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      const pane = paneRootRef.current
      if (!pane) return
      setActive(isInProjectDropZone(pane, e.clientX, e.clientY))
    }

    const onDragLeave = (e: DragEvent) => {
      const pane = paneRootRef.current
      if (!pane) return
      const related = e.relatedTarget as Node | null
      if (related && pane.contains(related)) return
      setActive(false)
    }

    const onDrop = (e: DragEvent) => {
      const pane = paneRootRef.current
      const inZone = pane ? isInProjectDropZone(pane, e.clientX, e.clientY) : false
      setActive(false)
      if (!inZone) return

      // 中心区：拦住 HTML5 drop，避免和输入框抢；Tauri 已处理则跳过
      e.preventDefault()
      e.stopPropagation()
      if (Date.now() - lastTauriDropAtRef.current < 750) return

      // 浏览器一般没有本地绝对路径；有 path 字段时（部分 WebView）才尝试添加
      for (const file of Array.from(e.dataTransfer?.files ?? [])) {
        const path = (file as File & { path?: string }).path
        if (typeof path === 'string' && path) addDirectoryRef.current(path)
      }
    }

    const pane = paneRootRef.current
    if (pane) {
      pane.addEventListener('dragover', onDragOver, true)
      pane.addEventListener('dragleave', onDragLeave, true)
      pane.addEventListener('drop', onDrop, true)
    }

    return () => {
      alive = false
      unlistenTauri()
      if (pane) {
        pane.removeEventListener('dragover', onDragOver, true)
        pane.removeEventListener('dragleave', onDragLeave, true)
        pane.removeEventListener('drop', onDrop, true)
      }
    }
  }, [paneRootRef])

  return isActive
}
