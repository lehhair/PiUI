import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { JsonView } from '../../../components/JsonView'
import {
  registerProviderAuthFlow,
  trackManagementProviders,
  useManagementEvents,
} from '../../../pi/managementEventStore'
import type { PiModelRuntimeSnapshot, PiProviderAuthInfo } from '../../../pi/domain'
import {
  inspectModelRuntime,
  listPiProviders,
  logoutProvider,
  refreshModelRuntime,
  reloadModelRuntime,
  removeProviderApiKey,
  setProviderApiKey,
  startProviderAuth,
} from '../../../pi/transport/index.js'
import { loadPiModels } from '../../../pi/controllers/index.js'
import { SettingsSection, SettingsDisclosure, settingsFieldClass } from './SettingsUI'

export function PiProviderManagement() {
  const { t } = useTranslation(['settings', 'common'])
  const [providers, setProviders] = useState<PiProviderAuthInfo[]>([])
  const [query, setQuery] = useState('')
  const [runtime, setRuntime] = useState<PiModelRuntimeSnapshot | null>(null)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { providerRevision } = useManagementEvents()

  const load = useCallback(async () => {
    try {
      const [nextProviders, nextRuntime] = await Promise.all([
        listPiProviders(),
        inspectModelRuntime(),
      ])
      setProviders(nextProviders)
      setRuntime(nextRuntime)
      trackManagementProviders(nextProviders.map(provider => provider.id))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

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

  const beginAuth = async (provider: PiProviderAuthInfo, type: 'api_key' | 'oauth') => {
    setBusy(`auth:${provider.id}:${type}`)
    setError(null)
    try {
      trackManagementProviders([provider.id])
      const { flowId } = await startProviderAuth(provider.id, type)
      registerProviderAuthFlow(flowId, provider.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const visibleProviders = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const filtered = keyword
      ? providers.filter(provider => provider.name.toLowerCase().includes(keyword) || provider.id.toLowerCase().includes(keyword))
      : providers
    // 已配置的排前面，同组内按名称排序
    return [...filtered].sort(
      (a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name),
    )
  }, [providers, query])

  return (
    <SettingsSection
      title={t('pi.providersTitle')}
      description={t('pi.providersDescription')}
      actions={
        <>
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('refresh', async () => { await refreshModelRuntime(); await loadPiModels() })}>{t('common:refresh')}</Button>
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('reload', async () => { await reloadModelRuntime(); await loadPiModels() })}>{t('common:reload')}</Button>
        </>
      }
    >
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}

      <p className="text-[length:var(--fs-xs)] text-text-400">
        {runtime
          ? t('pi.runtimeSummary', {
              providers: runtime.providers.length,
              models: runtime.availableModels.length,
              registered: runtime.registeredProviderIds.length,
            })
          : t('pi.loadingRuntime')}
      </p>
      {runtime?.error ? <p className="text-[length:var(--fs-xs)] text-danger-100">{runtime.error}</p> : null}
      {runtime ? (
        <SettingsDisclosure title={t('pi.runtimeInspection')}>
          <JsonView value={runtime} className="max-h-56" />
        </SettingsDisclosure>
      ) : null}

      {providers.length > 0 ? (
        <input
          className={settingsFieldClass}
          placeholder={t('pi.searchProviders')}
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      ) : null}

      <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
        {visibleProviders.length === 0 && providers.length > 0 ? (
          <p className="py-2 text-center text-[length:var(--fs-xs)] text-text-400">{t('pi.noProvidersMatch')}</p>
        ) : null}
        {visibleProviders.map(provider => (
          <div key={provider.id} className="space-y-2 rounded-lg border border-border-200 bg-bg-100 p-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)] text-text-200">{provider.name}</span>
              <span className={`text-[length:var(--fs-xs)] ${provider.configured ? 'text-success-100' : 'text-text-500'}`}>{provider.configured ? t('pi.configured') : t('pi.notConfigured')}</span>
              {provider.methods.filter(method => method.loginAvailable).map(method => (
                <Button key={method.type} size="sm" variant="secondary" disabled={busy !== null} isLoading={busy === `auth:${provider.id}:${method.type}`} onClick={() => void beginAuth(provider, method.type)}>{method.name || method.type}</Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <input type="password" className={`${settingsFieldClass} min-w-44 flex-1`} placeholder={t('pi.apiKeyPlaceholder')} value={apiKeys[provider.id] ?? ''} onChange={event => setApiKeys(keys => ({ ...keys, [provider.id]: event.target.value }))} />
              <Button size="sm" disabled={busy !== null || !apiKeys[provider.id]?.trim()} onClick={() => void run(`key:${provider.id}`, async () => {
                await setProviderApiKey(provider.id, apiKeys[provider.id])
                setApiKeys(keys => ({ ...keys, [provider.id]: '' }))
              })}>{t('pi.setKey')}</Button>
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`clear:${provider.id}`, () => removeProviderApiKey(provider.id).then(() => undefined))}>{t('pi.clearKey')}</Button>
              {provider.configured ? <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run(`logout:${provider.id}`, () => logoutProvider(provider.id).then(() => undefined))}>{t('pi.logout')}</Button> : null}
            </div>
            {provider.status != null ? (
              <SettingsDisclosure title={t('pi.authStatus')}>
                <JsonView value={provider.status} />
              </SettingsDisclosure>
            ) : null}
          </div>
        ))}
      </div>
    </SettingsSection>
  )
}
