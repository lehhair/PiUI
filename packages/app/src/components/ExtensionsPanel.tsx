import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { extensionUiStore } from '../pi/extensionUiStore'

/**
 * Extensions panel — read-only view of the extension UI state for the
 * current session: statuses (key/value), widgets (text blocks incl.
 * todo-like content), and working indicator/title set by extensions.
 */
export function ExtensionsPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation('components')
  const snapshot = useSyncExternalStore(
    extensionUiStore.subscribe,
    extensionUiStore.getSnapshot,
    extensionUiStore.getSnapshot,
  )
  const state = sessionId ? snapshot.sessions[sessionId]?.state : undefined

  if (!sessionId) {
    return <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">{t('rightPanel.noActiveSession')}</div>
  }

  const statuses = state ? Object.entries(state.statuses) : []
  const widgets = state ? Object.entries(state.widgets) : []
  const hasWorking = Boolean(state?.workingMessage || state?.workingIndicator || state?.title)

  if (!state || (statuses.length === 0 && widgets.length === 0 && !hasWorking)) {
    return (
      <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)] px-4 text-center">
        {t('extensionsPanel.empty', 'No extension state')}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto custom-scrollbar px-4 py-3 flex flex-col gap-4">
      {state.title && (
        <section>
          <SectionLabel>{t('extensionsPanel.title', 'Title')}</SectionLabel>
          <div className="text-[length:var(--fs-sm)] text-text-100">{state.title}</div>
        </section>
      )}

      {hasWorking && (state.workingMessage || state.workingIndicator) && (
        <section>
          <SectionLabel>{t('extensionsPanel.working', 'Working')}</SectionLabel>
          <div className="flex items-center gap-2 text-[length:var(--fs-sm)] text-accent-main-100">
            {state.workingIndicator?.frames?.[0] && <span>{state.workingIndicator.frames[0]}</span>}
            {state.workingMessage && <span>{state.workingMessage}</span>}
          </div>
        </section>
      )}

      {statuses.length > 0 && (
        <section>
          <SectionLabel>{t('extensionsPanel.statuses', 'Status')}</SectionLabel>
          <div className="flex flex-col gap-1">
            {statuses.map(([key, value]) => (
              <div key={key} className="text-[length:var(--fs-sm)] text-text-200">
                <span className="text-text-500">{key}:</span> {value}
              </div>
            ))}
          </div>
        </section>
      )}

      {widgets.map(([key, widget]) => (
        <section key={key}>
          <SectionLabel>
            {key}
            <span className="ml-1 text-text-500/60">({widget.placement})</span>
          </SectionLabel>
          <pre className="whitespace-pre-wrap rounded-md bg-bg-200/40 px-3 py-2 text-[length:var(--fs-sm)] text-text-200 font-mono">
            {widget.lines.join('\n')}
          </pre>
        </section>
      ))}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[length:var(--fs-xs)] uppercase tracking-wide text-text-500">{children}</div>
}
