import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import {
  clearProviderAuthEvent,
  dismissProviderAuthFlow,
  useManagementEvents,
  type ProviderAuthFlowState,
} from '../../pi/managementEventStore'
import type { ProviderAuthPrompt } from '@piui/protocol'
import { cancelProviderAuth, respondProviderAuth } from '../../pi/transport/index.js'

export function ProviderAuthDialogHost() {
  const { flows } = useManagementEvents()
  const flow = useMemo(() => Object.values(flows).find(item => item.event), [flows])
  if (!flow) return null
  return <ProviderAuthDialog key={`${flow.flowId}:${flow.event?.type}`} flow={flow} />
}

function ProviderAuthDialog({ flow }: { flow: ProviderAuthFlowState }) {
  const event = flow.event
  const prompt = event?.type === 'prompt' ? (event.prompt as ProviderAuthPrompt) : undefined
  const [value, setValue] = useState(prompt?.type === 'select' ? prompt.options?.[0]?.id ?? '' : '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!event) return null
  const terminal = event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled'

  const close = async () => {
    if (terminal) {
      dismissProviderAuthFlow(flow.flowId)
      return
    }
    setSubmitting(true)
    try {
      await cancelProviderAuth(flow.flowId)
      dismissProviderAuthFlow(flow.flowId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSubmitting(false)
    }
  }

  const submit = async () => {
    if (event.type !== 'prompt') return
    setSubmitting(true)
    setError(null)
    try {
      await respondProviderAuth(flow.flowId, event.promptId, value)
      clearProviderAuthEvent(flow.flowId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog isOpen onClose={() => void close()} title="Provider authentication" width={500} showCloseButton={!submitting}>
      <div className="space-y-4">
        <p className="text-[length:var(--fs-xs)] text-text-400">Provider: {flow.providerId}{flow.sessionId ? ' · session scope' : ' · global scope'}</p>
        {event.type === 'prompt' ? (
          <>
            <p className="whitespace-pre-wrap text-[length:var(--fs-sm)] text-text-200">{prompt!.message}</p>
            {prompt!.type === 'select' ? (
              <div className="space-y-2">
                {prompt!.options?.map(option => (
                  <label key={option.id} className="flex cursor-pointer gap-2 rounded-md border border-border-100 p-2 text-[length:var(--fs-sm)] text-text-200">
                    <input type="radio" name="provider-auth-option" value={option.id} checked={value === option.id} onChange={() => setValue(option.id)} />
                    <span><span className="block text-text-100">{option.label}</span>{option.description ? <span className="block text-[length:var(--fs-xs)] text-text-400">{option.description}</span> : null}</span>
                  </label>
                ))}
              </div>
            ) : (
              <input
                autoFocus
                type={prompt!.type === 'secret' ? 'password' : 'text'}
                value={value}
                placeholder={prompt!.placeholder}
                onChange={input => setValue(input.target.value)}
                onKeyDown={key => { if (key.key === 'Enter' && value) void submit() }}
                className="h-9 w-full rounded-md border border-border-200 bg-bg-100 px-3 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100"
              />
            )}
          </>
        ) : event.type === 'notification' ? (
          <div className="space-y-2"><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-200/50 p-3 text-[length:var(--fs-xs)] text-text-200">{formatNotification(event.event)}</pre>{extractUrls(event.event).map(url => <a key={url} href={url} target="_blank" rel="noreferrer" className="block break-all text-[length:var(--fs-xs)] text-accent-main-100 underline">Open authentication URL</a>)}</div>
        ) : event.type === 'failed' ? (
          <p className="text-[length:var(--fs-sm)] text-danger-100">{event.message}</p>
        ) : (
          <p className="text-[length:var(--fs-sm)] text-text-200">{event.type === 'completed' ? 'Authentication completed.' : 'Authentication cancelled.'}</p>
        )}
        {flow.notifications.length > 0 && event.type !== 'notification' ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-200/40 p-2 text-[length:var(--fs-xs)] text-text-400">{flow.notifications.map(formatNotification).join('\n')}</pre>
        ) : null}
        {error ? <p role="alert" className="text-[length:var(--fs-sm)] text-danger-100">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={submitting} onClick={() => void close()}>{terminal ? 'Close' : 'Cancel'}</Button>
          {event.type === 'prompt' ? <Button isLoading={submitting} disabled={!value} onClick={() => void submit()}>Continue</Button> : null}
          {event.type === 'notification' ? <Button disabled={submitting} onClick={() => clearProviderAuthEvent(flow.flowId)}>Keep waiting</Button> : null}
        </div>
      </div>
    </Dialog>
  )
}

function formatNotification(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function extractUrls(value: unknown): string[] {
  const urls = new Set<string>()
  const visit = (candidate: unknown) => {
    if (typeof candidate === 'string') {
      for (const match of candidate.matchAll(/https?:\/\/[^\s"'<>]+/g)) urls.add(match[0])
      return
    }
    if (Array.isArray(candidate)) candidate.forEach(visit)
    else if (candidate && typeof candidate === 'object') Object.values(candidate).forEach(visit)
  }
  visit(value)
  return [...urls]
}
