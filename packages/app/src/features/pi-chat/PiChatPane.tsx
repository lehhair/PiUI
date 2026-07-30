import { useCallback, useEffect, useMemo } from 'react'
import { ChatArea, InputBox } from '../chat/index.js'
import type { Attachment } from '../attachment/index.js'
import { piBranchToMessages } from '../../pi/piChatViewModel.js'
import { piEventStream } from '../../pi/eventStream.js'
import {
  abortPiOperation,
  loadMorePiBranchEntries,
  loadPiSessionData,
  sendPiFollowUp,
  sendPiPrompt,
  sendPiSteer,
} from '../../pi/controllers/index.js'
import { piBranchStore } from '../../pi/state/index.js'
import { usePiBranchData, usePiSessionRuntimeState } from '../../pi/hooks/index.js'

interface PiChatPaneProps {
  paneId: string
  sessionId: string | null
}

/**
 * Pi-native chat pane. All rendering reuses the existing chat components
 * (ChatArea, InputBox); only the data source is new — raw Pi stores via
 * selectors. The event stream keeps stores fresh while the pane is open.
 */
export function PiChatPane({ paneId, sessionId }: PiChatPaneProps) {
  // Self-heal on mount / session switch: make sure the event stream is
  // connected and session data is present (covers direct navigation where
  // App-level open was skipped, e.g. SESSION_BUSY reuse).
  useEffect(() => {
    if (!sessionId) return
    piEventStream.connect(sessionId)
    if (!piBranchStore.getData()) {
      void loadPiSessionData(sessionId).catch(() => undefined)
    }
  }, [sessionId])

  const branch = usePiBranchData()
  const state = usePiSessionRuntimeState()

  const cwd = typeof state?.cwd === 'string' ? state.cwd : ''
  const isStreaming = Boolean(state?.isStreaming)
  const queue = state?.queue as { steering?: string[]; followUp?: string[] } | undefined

  const messages = useMemo(
    () => (sessionId && branch ? piBranchToMessages(branch, sessionId, cwd) : []),
    [branch, sessionId, cwd],
  )

  const handleSend = useCallback(
    async (text: string, _attachments: Attachment[], options?: { delivery?: 'steer' | 'followUp' }) => {
      if (!sessionId) return false
      if (options?.delivery === 'steer') {
        await sendPiSteer(sessionId, text)
      } else if (options?.delivery === 'followUp' || isStreaming) {
        await sendPiFollowUp(sessionId, text)
      } else {
        await sendPiPrompt(sessionId, text)
      }
      return true
    },
    [sessionId, isStreaming],
  )

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center text-[length:var(--fs-sm)] text-text-500">
        Select a session to start chatting
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatArea
        messages={messages}
        queuedSteering={queue?.steering ?? []}
        queuedFollowUps={queue?.followUp ?? []}
        sessionId={sessionId}
        isStreaming={isStreaming}
        allowStreamingLayoutAnimation
        loadState={branch ? 'loaded' : 'loading'}
        hasMoreHistory={Boolean(branch?.hasMore)}
        onLoadMore={() => loadMorePiBranchEntries(sessionId)}
      />
      <InputBox
        paneId={paneId}
        sessionId={sessionId}
        onSend={handleSend}
        onAbort={() => void abortPiOperation(sessionId).catch(() => undefined)}
        isStreaming={isStreaming}
      />
    </div>
  )
}
