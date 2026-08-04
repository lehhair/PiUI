import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { RegistrySnapshot } from '@piui/protocol'
import { Button } from '../../../components/ui/Button'
import { JsonView } from '../../../components/JsonView'
import { extensionUiStore } from '../../../pi/extensionUiStore'
import { useManagementEvents } from '../../../pi/managementEventStore'
import { loadPiSessionRegistry, reloadPiSessionResources } from '../../../pi/controllers/index.js'
import { SettingsSection, SettingsDisclosure, settingsFieldClass } from './SettingsUI'

/**
 * Session resource inspector over the native runtime registry (registry.get).
 * Extensions, tools, commands and event handlers come straight from the
 * session's extension runner; reload goes through the native reload command.
 */
export function PiResourceManagement({ sessionId, workspacePath }: { sessionId: string | null; workspacePath: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const [registry, setRegistry] = useState<RegistrySnapshot | null>(null)
  const [eventType, setEventType] = useState('')
  const [handlerResult, setHandlerResult] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { resourceRevisions } = useManagementEvents()
  const resourceRevision = resourceRevisions[workspacePath]
  const extensionUi = useSyncExternalStore(extensionUiStore.subscribe, extensionUiStore.getSnapshot, extensionUiStore.getSnapshot)

  const load = useCallback(async () => {
    if (!sessionId) return
    try {
      setRegistry((await loadPiSessionRegistry(sessionId)) ?? null)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    const onRegistryUpdated = (event: Event) => {
      const updatedSessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId
      if (updatedSessionId === sessionId) void load()
    }
    window.addEventListener('piui:registry-updated', onRegistryUpdated)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('piui:registry-updated', onRegistryUpdated)
    }
  }, [load, resourceRevision])

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  if (!sessionId) {
    return (
      <SettingsSection title={t('pi.resourcesTitle')} description={t('pi.resourcesOpenSession')}>
        {null}
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      title={t('pi.resourcesTitle')}
      description={t('pi.resourcesDescription')}
      actions={
        <Button size="sm" variant="secondary" disabled={busy !== null} isLoading={busy === 'reload'} onClick={() => void run('reload', async () => { await reloadPiSessionResources(sessionId); await load() })}>{t('common:reload')}</Button>
      }
    >
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      <p className="text-[length:var(--fs-xs)] text-text-400">
        {registry
          ? t('pi.registrySummary', {
              extensions: registry.extensions.length,
              tools: registry.tools.length,
              active: registry.activeTools.length,
              commands: registry.commands.length,
              handlers: registry.eventHandlers.length,
            })
          : t('pi.loadingRegistry')}
      </p>

      {registry ? (
        <div className="space-y-2">
          <ResourceList title={t('pi.extensions')} items={registry.extensions.map(item => ({ name: item.path, detail: `${t('pi.extensionDetail', { tools: item.tools.length, commands: item.commands.length, handlers: item.handlers.length })}${item.hidden ? ` · ${t('pi.hidden')}` : ''}` }))} />
          <ResourceList title={t('pi.tools')} items={registry.tools.map(item => ({ name: `${item.name}${registry.activeTools.includes(item.name) ? '' : ` (${t('pi.inactive')})`}`, detail: item.description ?? '' }))} />
          <ResourceList title={t('pi.commands')} items={registry.commands.map(item => ({ name: item.name, detail: item.description ?? '' }))} />
          <ResourceList title={t('pi.eventHandlers')} items={registry.eventHandlers.map(name => ({ name, detail: '' }))} />
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <input className={settingsFieldClass} placeholder={t('pi.eventTypePlaceholder')} value={eventType} onChange={event => setEventType(event.target.value)} />
        <Button size="sm" variant="secondary" disabled={busy !== null || !eventType.trim()} onClick={() => setHandlerResult(registry?.eventHandlers.includes(eventType.trim()) ?? null)}>{t('pi.checkHandler')}</Button>
      </div>
      {handlerResult !== null ? (
        <p className="text-[length:var(--fs-xs)] text-text-300">
          {handlerResult ? t('pi.handlerRegistered', { eventType }) : t('pi.handlerNotRegistered', { eventType })}
        </p>
      ) : null}

      {registry ? <JsonDetails title={t('pi.registryData')} value={registry} /> : null}
      {extensionUi.sessions[sessionId] ? <JsonDetails title={t('pi.extensionUiState')} value={extensionUi.sessions[sessionId]} /> : null}
    </SettingsSection>
  )
}

function ResourceList({ title, items }: { title: string; items: Array<{ name: string; detail: string }> }) {
  return (
    <SettingsDisclosure title={title} count={items.length}>
      <div className="max-h-48 space-y-1 overflow-auto border-l border-border-200 pl-2">
        {items.map((item, index) => (
          <div key={`${item.name}:${index}`}>
            <p className="break-all text-[length:var(--fs-xs)] text-text-200">{item.name}</p>
            {item.detail ? <p className="line-clamp-3 whitespace-pre-wrap break-all text-[length:var(--fs-xs)] text-text-500">{item.detail}</p> : null}
          </div>
        ))}
      </div>
    </SettingsDisclosure>
  )
}

function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return (
    <SettingsDisclosure title={title}>
      <JsonView value={value} className="max-h-64" />
    </SettingsDisclosure>
  )
}
