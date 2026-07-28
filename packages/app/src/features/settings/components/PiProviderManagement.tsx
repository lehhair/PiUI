import { useCallback, useEffect, useState } from 'react'
import type { PiModelRuntimeSnapshotV1, ProviderAuthInfoV1 } from '@piui/protocol'
import { Button } from '../../../components/ui/Button'
import { refreshModels } from '../../../hooks/useModels'
import {
  registerProviderAuthFlow,
  trackManagementProviders,
  useManagementEvents,
} from '../../../pi/managementEventStore'
import {
  inspectModelRuntime,
  listPiProviders,
  listSessionProviders,
  logoutProvider,
  logoutSessionProvider,
  refreshModelRuntime,
  reloadModelRuntime,
  removeProviderApiKey,
  setProviderApiKey,
  setSessionProviderApiKey,
  startProviderAuth,
} from '../../../pi/sessionApi'

const inputClass = 'h-8 w-full rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100'

export function PiProviderManagement({ sessionId }: { sessionId: string | null }) {
  const [scope, setScope] = useState<'global' | 'session'>('global')
  const [providers, setProviders] = useState<ProviderAuthInfoV1[]>([])
  const [runtime, setRuntime] = useState<PiModelRuntimeSnapshotV1 | null>(null)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { providerRevision } = useManagementEvents()
  const scopedSessionId = scope === 'session' ? sessionId ?? undefined : undefined

  const load = useCallback(async () => {
    try {
      const [nextProviders, nextRuntime] = await Promise.all([
        scopedSessionId ? listSessionProviders(scopedSessionId) : listPiProviders(),
        inspectModelRuntime(scopedSessionId),
      ])
      setProviders(nextProviders)
      setRuntime(nextRuntime)
      if (!scopedSessionId) trackManagementProviders(nextProviders.map(provider => provider.id))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [scopedSessionId])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load, providerRevision])

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const beginAuth = async (provider: ProviderAuthInfoV1, type: 'api_key' | 'oauth') => {
    setBusy(`auth:${provider.id}:${type}`)
    setError(null)
    try {
      if (!scopedSessionId) trackManagementProviders([provider.id])
      const { flowId } = await startProviderAuth(provider.id, type, scopedSessionId)
      registerProviderAuthFlow(flowId, provider.id, scopedSessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div><h3 className="text-[length:var(--fs-sm)] font-medium text-text-100">Models and providers</h3><p className="text-[length:var(--fs-xs)] text-text-400">Inspect and refresh the Pi model runtime, authenticate providers, or apply a temporary API key.</p></div>
        <div className="flex rounded-md border border-border-200 p-0.5 text-[length:var(--fs-xs)]">
          <button className={`px-2 py-1 rounded ${scope === 'global' ? 'bg-bg-200 text-text-100' : 'text-text-400'}`} onClick={() => setScope('global')}>Global</button>
          <button disabled={!sessionId} className={`px-2 py-1 rounded disabled:opacity-40 ${scope === 'session' ? 'bg-bg-200 text-text-100' : 'text-text-400'}`} onClick={() => setScope('session')}>Session</button>
        </div>
      </div>

      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-2 border-y border-border-100 py-2">
        <span className="mr-auto text-[length:var(--fs-xs)] text-text-400">
          {runtime ? `${runtime.providers.length} providers · ${runtime.availableModels.length} available models · ${runtime.registeredProviderIds.length} registered` : 'Loading runtime…'}
        </span>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('refresh', async () => { await refreshModelRuntime(scopedSessionId); await refreshModels() })}>Refresh</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('reload', async () => { await reloadModelRuntime(scopedSessionId); await refreshModels() })}>Reload</Button>
      </div>
      {runtime?.error ? <p className="text-[length:var(--fs-xs)] text-danger-100">{runtime.error}</p> : null}
      {runtime ? <details className="text-[length:var(--fs-xs)]"><summary className="cursor-pointer text-text-300">Runtime inspection</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-200/40 p-2 text-text-400">{JSON.stringify(runtime, null, 2)}</pre></details> : null}

      <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
        {providers.map(provider => (
          <div key={provider.id} className="space-y-2 border-t border-border-100 pt-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)] text-text-200">{provider.name}</span>
              <span className={`text-[length:var(--fs-xs)] ${provider.configured ? 'text-success-100' : 'text-text-500'}`}>{provider.configured ? 'Configured' : 'Not configured'}</span>
              {provider.methods.filter(method => method.loginAvailable).map(method => (
                <Button key={method.type} size="sm" variant="secondary" disabled={busy !== null} isLoading={busy === `auth:${provider.id}:${method.type}`} onClick={() => void beginAuth(provider, method.type)}>{method.name || method.type}</Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              <input type="password" className={`${inputClass} min-w-44 flex-1`} placeholder="Temporary runtime API key" value={apiKeys[provider.id] ?? ''} onChange={event => setApiKeys(keys => ({ ...keys, [provider.id]: event.target.value }))} />
              <Button size="sm" disabled={busy !== null || !apiKeys[provider.id]?.trim()} onClick={() => void run(`key:${provider.id}`, async () => {
                if (scopedSessionId) await setSessionProviderApiKey(scopedSessionId, provider.id, apiKeys[provider.id])
                else await setProviderApiKey(provider.id, apiKeys[provider.id])
                setApiKeys(keys => ({ ...keys, [provider.id]: '' }))
              })}>Set</Button>
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`clear:${provider.id}`, () => removeProviderApiKey(provider.id, scopedSessionId))}>Clear key</Button>
              {provider.configured ? <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run(`logout:${provider.id}`, () => scopedSessionId ? logoutSessionProvider(scopedSessionId, provider.id) : logoutProvider(provider.id))}>Logout</Button> : null}
            </div>
            {provider.status != null ? <details className="text-[length:var(--fs-xs)] text-text-400"><summary className="cursor-pointer">Auth status</summary><pre className="mt-1 overflow-auto whitespace-pre-wrap">{JSON.stringify(provider.status, null, 2)}</pre></details> : null}
          </div>
        ))}
      </div>
    </section>
  )
}
