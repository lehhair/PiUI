import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ExtensionUiState } from '@piui/protocol'
import { extensionUiStore } from '../../pi/extensionUiStore'

export function ExtensionUiSurface({ sessionId, placement }: { sessionId: string | null; placement: 'aboveEditor' | 'belowEditor' }) {
  const snapshot = useSyncExternalStore(extensionUiStore.subscribe, extensionUiStore.getSnapshot, extensionUiStore.getSnapshot)
  if (!sessionId) return null
  const state = snapshot.sessions[sessionId]?.state
  if (!state) return null
  const widgets = Object.entries(state.widgets).filter(([, widget]) => widget.placement === placement)
  const showState = placement === 'aboveEditor' && (
    state.title || Object.keys(state.statuses).length || (state.workingVisible && state.workingMessage)
    || state.workingIndicator || state.hiddenThinkingLabel || state.themeName
  )
  if (!showState && widgets.length === 0) return null

  return (
    <div className="pointer-events-auto mx-auto w-full max-w-3xl px-4">
      <div className={`space-y-1 px-2 text-[length:var(--fs-xs)] ${placement === 'aboveEditor' ? 'pb-1' : 'pt-1'}`}>
        {showState ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-text-400">
          {state.title ? <span className="font-medium text-text-200">{state.title}</span> : null}
          {Object.entries(state.statuses).map(([key, value]) => <span key={key}><span className="text-text-500">{key}:</span> {value}</span>)}
          {state.workingVisible && state.workingIndicator ? <WorkingIndicator indicator={state.workingIndicator} /> : null}
          {state.workingVisible && state.workingMessage ? <span className="text-accent-main-100">{state.workingMessage}</span> : null}
          {state.hiddenThinkingLabel ? <span>{state.hiddenThinkingLabel}</span> : null}
          {state.themeName ? <span><span className="text-text-500">theme:</span> {state.themeName}</span> : null}
          <span><span className="text-text-500">tools:</span> {state.toolsExpanded ? 'expanded' : 'collapsed'}</span>
        </div> : null}
        {widgets.map(([key, widget]) => <div key={key} className="whitespace-pre-wrap break-words border-l border-border-200 pl-2 text-text-300">{widget.lines.join('\n')}</div>)}
      </div>
    </div>
  )
}

function WorkingIndicator({ indicator }: { indicator: NonNullable<ExtensionUiState['workingIndicator']> }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (indicator.frames.length < 2) return
    const timer = window.setInterval(() => setFrame(current => (current + 1) % indicator.frames.length), indicator.intervalMs ?? 120)
    return () => window.clearInterval(timer)
  }, [indicator])
  return <span className="font-mono text-accent-main-100">{indicator.frames[frame] ?? ''}</span>
}
