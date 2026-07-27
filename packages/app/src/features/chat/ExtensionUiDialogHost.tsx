import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExtensionUiDialogRequestV1, ExtensionUiDialogResponseV1 } from '@piui/protocol'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { extensionUiStore } from '../../pi/extensionUiStore'
import { respondExtensionUi } from '../../pi/sessionApi'

export function ExtensionUiDialogHost() {
  const snapshot = useSyncExternalStore(
    extensionUiStore.subscribe,
    extensionUiStore.getSnapshot,
    extensionUiStore.getSnapshot,
  )
  const request = useMemo(() => Object.values(snapshot.sessions)
    .flatMap(session => session.pending)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0], [snapshot])

  if (!request) return null
  return <ExtensionUiDialog key={request.requestId} request={request} />
}

function ExtensionUiDialog({ request }: { request: ExtensionUiDialogRequestV1 }) {
  const { t } = useTranslation('common')
  const [value, setValue] = useState(request.kind === 'select'
    ? request.options[0] ?? ''
    : request.kind === 'editor'
      ? request.prefill ?? ''
      : '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [responseId] = useState(() => globalThis.crypto?.randomUUID?.() ?? `${request.requestId}-${Date.now()}`)

  useEffect(() => {
    if (!request.expiresAt) return
    const remaining = new Date(request.expiresAt).getTime() - Date.now()
    if (remaining <= 0) {
      extensionUiStore.requestSettled(request.sessionId, request.requestId)
      return
    }
    const timer = window.setTimeout(
      () => extensionUiStore.requestSettled(request.sessionId, request.requestId),
      remaining,
    )
    return () => clearTimeout(timer)
  }, [request])

  const send = async (response: ExtensionUiDialogResponseV1) => {
    setSubmitting(true)
    setError(null)
    try {
      await respondExtensionUi(request.sessionId, request.requestId, {
        ...response,
        responseId,
      }, request.workerGeneration)
      extensionUiStore.requestSettled(request.sessionId, request.requestId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSubmitting(false)
    }
  }

  const submit = () => {
    if (request.kind === 'confirm') return send({ confirmed: true })
    return send({ value })
  }
  const cancel = () => request.kind === 'confirm'
    ? send({ confirmed: false })
    : send({ cancelled: true })

  return (
    <Dialog
      isOpen
      onClose={() => void send({ cancelled: true })}
      title={request.title}
      width={460}
      showCloseButton={!submitting}
    >
      <div className="flex flex-col gap-4">
        {request.kind === 'confirm' && request.message && (
          <p className="text-sm text-text-200 whitespace-pre-wrap">{request.message}</p>
        )}
        {request.kind === 'select' && (
          <select
            value={value}
            onChange={event => setValue(event.target.value)}
            disabled={submitting}
            className="h-9 w-full rounded-md border border-border-200 bg-bg-100 px-2 text-sm text-text-100"
            autoFocus
          >
            {request.options.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        )}
        {request.kind === 'input' && (
          <input
            value={value}
            onChange={event => setValue(event.target.value)}
            placeholder={request.placeholder}
            disabled={submitting}
            className="h-9 w-full rounded-md border border-border-200 bg-bg-100 px-3 text-sm text-text-100 outline-none focus:border-accent-main-000"
            autoFocus
          />
        )}
        {request.kind === 'editor' && (
          <textarea
            value={value}
            onChange={event => setValue(event.target.value)}
            disabled={submitting}
            rows={8}
            className="w-full resize-y rounded-md border border-border-200 bg-bg-100 p-3 font-mono text-sm text-text-100 outline-none focus:border-accent-main-000"
            autoFocus
          />
        )}
        {error && <p role="alert" className="text-sm text-danger-100">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => void cancel()} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void submit()} isLoading={submitting} disabled={request.kind !== 'confirm' && !value}>
            {request.kind === 'confirm' ? t('confirm') : t('submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
