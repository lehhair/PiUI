import { useMemo, useSyncExternalStore } from 'react'
import type { ExtensionUiDialogRequest } from '@piui/protocol'
import { extensionUiStore } from '../../pi/extensionUiStore'
import { usePresence } from '../../hooks'
import { ExtensionUiDialogCard } from './ExtensionUiDialogCard'

/**
 * Extension UI dialog host — renders pending extension dialog requests
 * (select/confirm/input/editor) as a floating card above the composer,
 * same interaction spot as permission/question cards.
 */
export function ExtensionUiDialogHost({ sessionId }: { sessionId: string | null }) {
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

  if (!request) return null
  return <ExtensionUiDialogCardWrapper request={request} queueLength={pending.length} />
}

function ExtensionUiDialogCardWrapper({
  request,
  queueLength,
}: {
  request: ExtensionUiDialogRequest
  queueLength: number
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
        <ExtensionUiDialogCard request={request} queueLength={queueLength} />
      </div>
    </div>
  )
}
