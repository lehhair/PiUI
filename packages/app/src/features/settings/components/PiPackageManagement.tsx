import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ConfiguredPackageV1,
  PackageResolveMissingActionV1,
  PackageUpdateV1,
  ResolvedPackageResourcesV1,
} from '@piui/protocol'
import { Button } from '../../../components/ui/Button'
import { useManagementEvents } from '../../../pi/managementEventStore'
import {
  changePiPackageSource,
  checkPiPackageUpdates,
  getPiPackageInstalledPath,
  listPiPackages,
  managePiPackageDetailed,
  resolvePiExtensionSources,
  resolvePiPackages,
} from '../../../pi/sessionApi'

const inputClass = 'h-8 w-full rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100'

export function PiPackageManagement({ workspacePath }: { workspacePath: string }) {
  const [packages, setPackages] = useState<ConfiguredPackageV1[]>([])
  const [updates, setUpdates] = useState<PackageUpdateV1[]>([])
  const [resolved, setResolved] = useState<ResolvedPackageResourcesV1 | null>(null)
  const [source, setSource] = useState('')
  const [projectLocal, setProjectLocal] = useState(true)
  const [temporary, setTemporary] = useState(false)
  const [missingAction, setMissingAction] = useState<PackageResolveMissingActionV1>('skip')
  const [installedPaths, setInstalledPaths] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { packageProgress } = useManagementEvents()
  const progress = useMemo(() => Object.values(packageProgress).filter(item => !item.workspacePath || item.workspacePath === workspacePath).slice(-8), [packageProgress, workspacePath])

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
    const result = await managePiPackageDetailed(workspacePath, action, packageSource, local)
    setPackages(result.packages)
    if (action === 'install') setSource('')
    setUpdates(await checkPiPackageUpdates(workspacePath))
  }

  return (
    <section className="space-y-3">
      <div><h3 className="text-[length:var(--fs-sm)] font-medium text-text-100">Packages</h3><p className="text-[length:var(--fs-xs)] text-text-400">Install packages, maintain configured sources, resolve resources and apply available updates.</p></div>
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <input className={inputClass} placeholder="npm package, Git URL, or local path" value={source} onChange={event => setSource(event.target.value)} />
        <Button size="sm" disabled={busy !== null || !source.trim()} isLoading={busy === 'install'} onClick={() => void run('install', () => manage('install', source.trim()))}>Install</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[length:var(--fs-xs)] text-text-400">
        <label className="flex items-center gap-1"><input type="checkbox" checked={projectLocal} onChange={event => setProjectLocal(event.target.checked)} />Project scope</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={temporary} onChange={event => setTemporary(event.target.checked)} />Temporary resolve</label>
        <Button size="sm" variant="secondary" disabled={busy !== null || !source.trim()} onClick={() => void run('add-source', async () => { const result = await changePiPackageSource(workspacePath, source.trim(), 'add', projectLocal); setPackages(result.packages); setSource('') })}>Add source</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null || !source.trim()} onClick={() => void run('resolve-source', async () => setResolved(await resolvePiExtensionSources(workspacePath, [source.trim()], { local: projectLocal, temporary })))}>Resolve source</Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-y border-border-100 py-2">
        <select className="h-8 rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-xs)] text-text-200" value={missingAction} onChange={event => setMissingAction(event.target.value as PackageResolveMissingActionV1)}>
          <option value="skip">Skip missing</option><option value="install">Install missing</option><option value="error">Error on missing</option>
        </select>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('resolve', async () => setResolved(await resolvePiPackages(workspacePath, missingAction)))}>Resolve configured</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('updates', async () => setUpdates(await checkPiPackageUpdates(workspacePath)))}>Check updates</Button>
        <Button size="sm" disabled={busy !== null} onClick={() => void run('update-all', () => manage('update'))}>Update all</Button>
      </div>

      {updates.length ? <div className="space-y-1 rounded-md bg-bg-200/35 p-2">{updates.map(update => <div key={`${update.scope}:${update.source}`} className="flex items-center gap-2 text-[length:var(--fs-xs)]"><span className="min-w-0 flex-1 truncate text-text-300">{update.displayName} · {update.scope} · {update.type}</span><Button size="sm" disabled={busy !== null} onClick={() => void run(`update:${update.source}`, () => manage('update', update.source, update.scope === 'project'))}>Update</Button></div>)}</div> : null}

      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {packages.map(item => {
          const key = `${item.scope}:${item.source}`
          return <div key={key} className="space-y-1 border-t border-border-100 pt-2"><div className="flex flex-wrap items-center gap-2"><div className="min-w-44 flex-1"><p className="truncate text-[length:var(--fs-sm)] text-text-200">{item.source}</p><p className="text-[length:var(--fs-xs)] text-text-400">{item.scope}{item.filtered ? ' · filtered' : ''}{item.installedPath ? ` · ${item.installedPath}` : ''}</p></div><Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`path:${key}`, async () => { const path = await getPiPackageInstalledPath(workspacePath, item.source, item.scope); setInstalledPaths(paths => ({ ...paths, [key]: path })) })}>Path</Button><Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`source:${key}`, async () => { const result = await changePiPackageSource(workspacePath, item.source, 'remove', item.scope === 'project'); setPackages(result.packages) })}>Remove source</Button><Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run(`remove:${key}`, () => manage('remove', item.source, item.scope === 'project'))}>Uninstall</Button></div>{installedPaths[key] ? <p className="break-all text-[length:var(--fs-xs)] text-text-400">{installedPaths[key]}</p> : null}</div>
        })}
      </div>

      {resolved ? <details open className="text-[length:var(--fs-xs)]"><summary className="cursor-pointer text-text-300">Resolved resources</summary><div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">{(['extensions', 'skills', 'prompts', 'themes'] as const).map(kind => <div key={kind}><p className="font-medium text-text-300">{kind} ({resolved[kind].length})</p>{resolved[kind].map(item => <p key={item.path} className="truncate text-text-500" title={item.path}>{item.enabled ? 'on' : 'off'}: {item.path}</p>)}</div>)}</div></details> : null}
      {progress.length ? <details className="text-[length:var(--fs-xs)]"><summary className="cursor-pointer text-text-300">Recent package progress</summary><div className="mt-1 space-y-1">{progress.map(item => <p key={item.commandId} className={item.type === 'error' ? 'text-danger-100' : 'text-text-400'}>{item.action} {item.source}: {item.message ?? item.type}</p>)}</div></details> : null}
    </section>
  )
}
