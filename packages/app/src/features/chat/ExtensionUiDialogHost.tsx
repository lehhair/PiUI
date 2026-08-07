import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExtensionUiDialogRequest, ExtensionUiDialogResponse } from '@piui/protocol'
import { QuestionIcon, CheckIcon } from '../../components/Icons'
import { extensionUiStore } from '../../pi/extensionUiStore'
import { respondPiExtensionUi } from '../../pi/controllers/index.js'
import { usePresence } from '../../hooks'

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
  const pending = sessionId ? snapshot.sessions[sessionId]?.pending ?? [] : []
  const request = useMemo(
    () => [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0],
    [pending],
  )

  if (!request) return null
  return <ExtensionUiDialogCard key={request.requestId} request={request} queueLength={pending.length} />
}

function ExtensionUiDialogCard({ request, queueLength }: { request: ExtensionUiDialogRequest; queueLength: number }) {
  const { t } = useTranslation(['common'])
  const [value, setValue] = useState(() =>
    request.kind === 'select'
      ? request.options[0] ?? ''
      : request.kind === 'editor'
        ? request.prefill ?? ''
        : '',
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [responseId] = useState(() => globalThis.crypto?.randomUUID?.() ?? `${request.requestId}-${Date.now()}`)

  // 弹出动画（同 PermissionDialog）
  const { shouldRender, ref: animRef } = usePresence<HTMLDivElement>(true, {
    from: { opacity: 0, transform: 'translateY(16px)' },
    to: { opacity: 1, transform: 'translateY(0px)' },
    duration: 0.2,
  })

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

  const send = async (response: ExtensionUiDialogResponse) => {
    setSubmitting(true)
    setError(null)
    try {
      await respondPiExtensionUi(request.sessionId, request.requestId, {
        ...response,
        responseId,
      } as never)
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
  const cancel = () =>
    request.kind === 'confirm' ? send({ confirmed: false }) : send({ cancelled: true })

  if (!shouldRender) return null

  return (
    <div ref={animRef} className="absolute bottom-0 left-0 right-0 z-[11]">
      <div className="mx-auto max-w-3xl pointer-events-auto transition-[max-width] duration-300 ease-in-out px-3.5 pb-2">
        <div className="overflow-hidden rounded-xl border border-border-200/60 bg-bg-100 shadow-float">
          <div className="flex items-center gap-2 px-4 py-2.5">
            <QuestionIcon size={16} className="shrink-0 text-text-400" />
            <h3 className="min-w-0 truncate text-[length:var(--fs-sm)] font-medium text-text-100">
              {request.title}
            </h3>
            {queueLength > 1 && (
              <span className="shrink-0 rounded-md bg-bg-200 px-1.5 py-0.5 text-[length:var(--fs-xs)] text-text-400">
                +{queueLength - 1}
              </span>
            )}
          </div>

          {/* Body */}
          <div className="px-4 py-3 flex flex-col gap-3">
            {request.kind === 'confirm' && request.message && (
              <p className="text-[length:var(--fs-sm)] text-text-200 whitespace-pre-wrap">{request.message}</p>
            )}

            {request.kind === 'select' && (
              <div className="flex flex-col gap-1">
                {request.options.map(option => {
                  const selected = value === option
                  return (
                    <button
                      key={option}
                      type="button"
                      disabled={submitting}
                      onClick={() => setValue(option)}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-[length:var(--fs-sm)] transition-colors ${
                        selected
                          ? 'border-accent-main-100/60 bg-accent-main-100/10 text-text-100'
                          : 'border-border-200/60 bg-bg-100 text-text-300 hover:border-border-300 hover:text-text-100'
                      }`}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center shrink-0 ${selected ? 'text-accent-main-100' : 'text-text-500'}`}>
                        {selected && <CheckIcon size={14} />}
                      </span>
                      <span className="flex-1 truncate">{option}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {request.kind === 'input' && (
              <input
                value={value}
                onChange={event => setValue(event.target.value)}
                placeholder={request.placeholder}
                disabled={submitting}
                autoFocus
                className="h-9 w-full rounded-md border border-border-200 bg-bg-100 px-3 text-[length:var(--fs-sm)] text-text-100 outline-none transition-colors hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30"
              />
            )}

            {request.kind === 'editor' && (
              <textarea
                value={value}
                onChange={event => setValue(event.target.value)}
                disabled={submitting}
                rows={8}
                autoFocus
                className="w-full resize-y rounded-md border border-border-200 bg-bg-100 p-3 font-mono text-[length:var(--fs-sm)] text-text-100 outline-none transition-colors hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30"
              />
            )}

            {error && <p role="alert" className="text-[length:var(--fs-sm)] text-danger-100">{error}</p>}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 px-4 py-2.5">
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={submitting}
              className="px-2.5 py-1 rounded-md text-[length:var(--fs-sm)] text-text-400 hover:text-danger-100 transition-colors disabled:opacity-50"
            >
              {t('common:cancel')}
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting || (request.kind !== 'confirm' && !value)}
              className="px-3 py-1 rounded-md text-[length:var(--fs-sm)] font-medium bg-text-100 text-bg-000 hover:bg-text-200 transition-colors disabled:opacity-50"
            >
              {submitting ? '…' : request.kind === 'confirm' ? t('common:confirm') : t('common:submit')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
