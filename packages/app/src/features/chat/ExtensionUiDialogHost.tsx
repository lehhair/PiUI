import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ExtensionUiDialogRequest } from '@piui/protocol'
import { extensionUiStore } from '../../pi/extensionUiStore'
import { usePresence } from '../../hooks'
import { ExtensionUiDialogCard } from './ExtensionUiDialogCard'

/**
 * Extension UI dialog host — renders pending extension dialog requests
 * (select/confirm/input/editor) as a floating card above the composer,
 * same interaction spot as permission/question cards.
 *
 * 收起支持（对齐 OpenCodeUI 权限/提问弹窗）：卡片可收起为输入框上方的
 * 胶囊（胶囊由 InputBox 的 FloatingActions 渲染，host 只负责卡片的显隐）。
 * collapsed 为受控 prop——外部（PiChatPane）管理收起状态并渲染胶囊；
 * 不传时内部自管（兼容独立使用/测试）。新请求到来自动展开。
 */
export function ExtensionUiDialogHost({
  sessionId,
  collapsed,
  onCollapsedChange,
}: {
  sessionId: string | null
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}) {
  const snapshot = useSyncExternalStore(
    extensionUiStore.subscribe,
    extensionUiStore.getSnapshot,
    extensionUiStore.getSnapshot,
  )
  const pending = useMemo(
    () => (sessionId ? snapshot.sessions[sessionId]?.pending ?? [] : []),
    [sessionId, snapshot],
  )
  const request = useMemo(
    () => [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0],
    [pending],
  )
  // 受控优先；未受控时内部自管（独立使用）
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const isCollapsed = collapsed ?? internalCollapsed
  const setCollapsed = onCollapsedChange ?? setInternalCollapsed

  // 新请求到来 / 请求切换：自动展开（用户收起的胶囊让位给新请求）
  useEffect(() => {
    if (request?.requestId) setCollapsed(false)
  }, [request?.requestId, setCollapsed])

  if (!request || isCollapsed) return null

  return <ExtensionUiDialogCardWrapper request={request} queueLength={pending.length} onCollapse={() => setCollapsed(true)} />
}

function ExtensionUiDialogCardWrapper({
  request,
  queueLength,
  onCollapse,
}: {
  request: ExtensionUiDialogRequest
  queueLength: number
  onCollapse?: () => void
}) {
  // 弹出动画
  const { shouldRender, ref: animRef } = usePresence<HTMLDivElement>(true, {
    from: { opacity: 0, transform: 'translateY(16px)' },
    to: { opacity: 1, transform: 'translateY(0px)' },
    duration: 0.2,
  })

  if (!shouldRender) return null

  return (
    <div ref={animRef} className="absolute bottom-0 left-0 right-0 z-[11]">
      <div className="mx-auto max-w-3xl pointer-events-auto transition-[max-width] duration-300 ease-in-out px-3.5 pb-2">
        <ExtensionUiDialogCard request={request} queueLength={queueLength} onCollapse={onCollapse} />
      </div>
    </div>
  )
}
