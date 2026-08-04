import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import type { PiConfiguredPackage, PiPackageUpdate, ResolvedPaths } from '../../../pi/domain'
import {
  changePiPackageSource,
  checkPiPackageUpdates,
  getPiPackageInstalledPath,
  listPiPackages,
  managePiPackage,
  resolvePiExtensionSources,
  resolvePiPackages,
} from '../../../pi/transport/index.js'
import { Toggle, SettingsSection, SettingsSelect, SettingsDisclosure, settingsFieldClass } from './SettingsUI'

export function PiPackageManagement({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const [packages, setPackages] = useState<PiConfiguredPackage[]>([])
  const [updates, setUpdates] = useState<PiPackageUpdate[]>([])
  const [resolved, setResolved] = useState<ResolvedPaths | null>(null)
  const [source, setSource] = useState('')
  const [projectLocal, setProjectLocal] = useState(true)
  const [temporary, setTemporary] = useState(false)
  const [missingAction, setMissingAction] = useState<'install' | 'skip' | 'error'>('skip')
  const [installedPaths, setInstalledPaths] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setPackages(await listPiPackages(workspacePath))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [workspacePath])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

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

  const manage = async (action: 'install' | 'remove' | 'update', packageSource?: string, local = projectLocal) => {
    const next = await managePiPackage(workspacePath, {
      commandId: crypto.randomUUID(),
      action,
      source: packageSource,
      local,
    })
    setPackages(next)
    if (action === 'install') setSource('')
    setUpdates(await checkPiPackageUpdates(workspacePath))
  }

  return (
    <SettingsSection title={t('pi.packagesTitle')} description={t('pi.packagesDescription')}>
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <input className={settingsFieldClass} placeholder={t('pi.sourcePlaceholder')} value={source} onChange={event => setSource(event.target.value)} />
        <Button size="sm" disabled={busy !== null || !source.trim()} isLoading={busy === 'install'} onClick={() => void run('install', () => manage('install', source.trim()))}>{t('pi.install')}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Toggle enabled={projectLocal} onChange={() => setProjectLocal(value => !value)} ariaLabel={t('pi.projectScopeLabel')} />
          <span className="text-[length:var(--fs-xs)] text-text-300">{t('pi.projectScopeLabel')}</span>
        </div>
        <div className="flex items-center gap-2">
          <Toggle enabled={temporary} onChange={() => setTemporary(value => !value)} ariaLabel={t('pi.temporaryResolve')} />
          <span className="text-[length:var(--fs-xs)] text-text-300">{t('pi.temporaryResolve')}</span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy !== null || !source.trim()} onClick={() => void run('add-source', async () => { const result = await changePiPackageSource(workspacePath, source.trim(), 'add', projectLocal); setPackages(result.packages); setSource('') })}>{t('pi.addSource')}</Button>
          <Button size="sm" variant="secondary" disabled={busy !== null || !source.trim()} onClick={() => void run('resolve-source', async () => setResolved(await resolvePiExtensionSources(workspacePath, [source.trim()], { local: projectLocal, temporary })))}>{t('pi.resolveSource')}</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SettingsSelect
          ariaLabel={t('pi.skipMissing')}
          value={missingAction}
          onChange={setMissingAction}
          options={[
            { value: 'skip' as const, label: t('pi.skipMissing') },
            { value: 'install' as const, label: t('pi.installMissing') },
            { value: 'error' as const, label: t('pi.errorOnMissing') },
          ]}
        />
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('resolve', async () => setResolved(await resolvePiPackages(workspacePath, missingAction)))}>{t('pi.resolveConfigured')}</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('updates', async () => setUpdates(await checkPiPackageUpdates(workspacePath)))}>{t('pi.checkUpdates')}</Button>
        <Button size="sm" disabled={busy !== null} onClick={() => void run('update-all', () => manage('update'))}>{t('pi.updateAll')}</Button>
      </div>

      {updates.length ? (
        <div className="space-y-1 rounded-lg border border-border-200 bg-bg-100 p-2">
          {updates.map(update => (
            <div key={`${update.scope}:${update.source}`} className="flex items-center gap-2 text-[length:var(--fs-xs)]">
              <span className="min-w-0 flex-1 truncate text-text-300">{update.displayName} · {update.scope} · {update.type}</span>
              <Button size="sm" disabled={busy !== null} onClick={() => void run(`update:${update.source}`, () => manage('update', update.source, update.scope === 'project'))}>{t('pi.update')}</Button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {packages.map(item => {
          const key = `${item.scope}:${item.source}`
          return (
            <div key={key} className="space-y-1 rounded-lg border border-border-200 bg-bg-100 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-44 flex-1">
                  <p className="truncate text-[length:var(--fs-sm)] text-text-200">{item.source}</p>
                  <p className="text-[length:var(--fs-xs)] text-text-400">{item.scope}{item.filtered ? ` · ${t('pi.filtered')}` : ''}{item.installedPath ? ` · ${item.installedPath}` : ''}</p>
                </div>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`path:${key}`, async () => { const path = await getPiPackageInstalledPath(workspacePath, item.source, item.scope); setInstalledPaths(paths => ({ ...paths, [key]: path ?? t('pi.notInstalled') })) })}>{t('pi.showPath')}</Button>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`source:${key}`, async () => { const result = await changePiPackageSource(workspacePath, item.source, 'remove', item.scope === 'project'); setPackages(result.packages) })}>{t('pi.removeSource')}</Button>
                <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run(`remove:${key}`, () => manage('remove', item.source, item.scope === 'project'))}>{t('pi.uninstall')}</Button>
              </div>
              {installedPaths[key] ? <p className="break-all text-[length:var(--fs-xs)] text-text-400">{installedPaths[key]}</p> : null}
            </div>
          )
        })}
      </div>

      {resolved ? (
        <SettingsDisclosure title={t('pi.resolvedResources')} defaultOpen>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-[length:var(--fs-xs)]">
            {(['extensions', 'skills', 'prompts', 'themes'] as const).map(kind => (
              <div key={kind}>
                <p className="font-medium text-text-300">{kind} ({resolved[kind].length})</p>
                {resolved[kind].map(item => (
                  <p key={item.path} className="truncate text-text-500" title={item.path}>{item.enabled ? t('pi.resourceOn') : t('pi.resourceOff')}: {item.path}</p>
                ))}
              </div>
            ))}
          </div>
        </SettingsDisclosure>
      ) : null}
    </SettingsSection>
  )
}
