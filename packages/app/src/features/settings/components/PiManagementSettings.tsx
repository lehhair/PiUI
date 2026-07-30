import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { JsonObject } from '@piui/protocol'
import type { PiProjectTrust, PiSettingsSnapshot } from '../../../pi/domain'
import type { HostWorkspace } from '../../../pi/workspaces'
import { Button } from '../../../components/ui/Button'
import { useCurrentDirectory } from '../../../hooks'
import { useCurrentSessionId } from '../../../store/messageStoreHooks'
import {
  getPiSettings,
  getProjectTrust,
  patchPiSettings,
  setProjectTrust,
} from '../../../pi/transport/index.js'
import { listHostWorkspaces, resolveWorkspacePath } from '../../../pi/workspaces'
import { PiProviderManagement } from './PiProviderManagement'
import { PiPackageManagement } from './PiPackageManagement'
import { PiResourceManagement } from './PiResourceManagement'
import { PiSessionManagement } from './PiSessionManagement'

// Draft keys are the worker's flat settings.patch keys.
type SettingsDraft = {
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  transport?: 'auto' | 'sse' | 'websocket' | 'websocket-cached'
  steeringMode?: 'all' | 'one-at-a-time'
  followUpMode?: 'all' | 'one-at-a-time'
  compactionEnabled?: boolean
  retryEnabled?: boolean
  enableSkillCommands?: boolean
  showImages?: boolean
  shellPath?: string | null
  defaultProjectTrust?: 'ask' | 'always' | 'never'
  theme?: string
  httpProxy?: string | null
}

const inputClass = 'h-8 w-full rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100'

function draftFromSnapshot(snapshot: PiSettingsSnapshot): SettingsDraft {
  const settings = snapshot.effective
  return {
    defaultProvider: settings.defaultProvider ?? '',
    defaultModel: settings.defaultModel ?? '',
    defaultThinkingLevel: settings.defaultThinkingLevel ?? 'medium',
    transport: settings.transport,
    steeringMode: settings.steeringMode,
    followUpMode: settings.followUpMode,
    compactionEnabled: settings.compaction?.enabled,
    retryEnabled: settings.retry?.enabled,
    enableSkillCommands: settings.enableSkillCommands,
    showImages: settings.showImages,
    shellPath: settings.shellPath ?? '',
    theme: settings.theme ?? '',
    httpProxy: settings.httpProxy ?? '',
    defaultProjectTrust: settings.defaultProjectTrust,
  }
}

export function PiManagementSettings() {
  const directory = useCurrentDirectory()
  const sessionId = useCurrentSessionId()
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [settings, setSettings] = useState<PiSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [trust, setTrust] = useState<PiProjectTrust | null>(null)
  const [registeredWorkspaces, setRegisteredWorkspaces] = useState<HostWorkspace[]>([])
  const [advancedPatch, setAdvancedPatch] = useState('{}')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!directory) return
    setError(null)
    try {
      const canonical = await resolveWorkspacePath(directory)
      if (!canonical) throw new Error('Workspace is not available on the active server')
      setWorkspacePath(canonical)
      const [nextSettings, nextTrust, nextWorkspaces] = await Promise.all([
        getPiSettings(canonical),
        getProjectTrust(canonical),
        listHostWorkspaces(),
      ])
      setSettings(nextSettings)
      setDraft(draftFromSnapshot(nextSettings))
      setTrust(nextTrust)
      setRegisteredWorkspaces(nextWorkspaces)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load Pi runtime settings')
    }
  }, [directory])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const run = useCallback(async (name: string, action: () => Promise<void>, message: string) => {
    setBusy(name)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(message)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Operation failed')
    } finally {
      setBusy(null)
    }
  }, [])

  if (!directory) return <p className="text-[length:var(--fs-sm)] text-text-300">Open a workspace to configure Pi.</p>

  return (
    <div className="space-y-7 pb-6">
      <header>
        <h2 className="text-[length:var(--fs-lg)] font-medium text-text-100">Pi Runtime</h2>
        <p className="mt-1 text-[length:var(--fs-xs)] text-text-400 break-all">{workspacePath ?? directory}</p>
        <details className="mt-2 text-[length:var(--fs-xs)] text-text-400"><summary className="cursor-pointer">Registered workspaces ({registeredWorkspaces.length})</summary><div className="mt-1 max-h-32 overflow-auto border-l border-border-100 pl-2">{registeredWorkspaces.map(workspace => <p key={workspace.path} className="truncate" title={workspace.path}>{workspace.displayName} · {workspace.path}</p>)}</div></details>
      </header>

      {error ? <div className="border-l-2 border-danger-100 px-3 py-2 text-[length:var(--fs-sm)] text-danger-100">{error}</div> : null}
      {notice ? <div className="border-l-2 border-success-100 px-3 py-2 text-[length:var(--fs-sm)] text-text-200">{notice}</div> : null}

      <section className="space-y-3">
        <div>
          <h3 className="text-[length:var(--fs-sm)] font-medium text-text-100">Project trust</h3>
          <p className="text-[length:var(--fs-xs)] text-text-400">Trust controls whether project extensions, skills and prompts may load.</p>
        </div>
        <div className="flex items-center justify-between gap-4 border-y border-border-100 py-3">
          <span className="text-[length:var(--fs-sm)] text-text-200">{trust?.trusted ? 'Trusted' : trust?.decision === false ? 'Not trusted' : 'Decision required'}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => workspacePath && void run('trust-reset', async () => setTrust(await setProjectTrust(workspacePath, null)), 'Trust decision reset')}>Reset</Button>
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => workspacePath && void run('trust-deny', async () => setTrust(await setProjectTrust(workspacePath, false)), 'Project marked untrusted')}>Deny</Button>
            <Button size="sm" disabled={busy !== null} onClick={() => workspacePath && void run('trust-allow', async () => setTrust(await setProjectTrust(workspacePath, true)), 'Project trusted')}>Trust</Button>
          </div>
        </div>
        {trust ? <p className="text-[length:var(--fs-xs)] text-text-400">Required: {String(trust.required)} · saved decision: {trust.decision === null ? 'none' : String(trust.decision)} · default: {trust.defaultDecision}{trust.inheritedFrom ? ` · inherited from ${trust.inheritedFrom}` : ''}</p> : null}
      </section>

      {settings && draft ? (
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-4">
            <div><h3 className="text-[length:var(--fs-sm)] font-medium text-text-100">Runtime settings</h3><p className="text-[length:var(--fs-xs)] text-text-400">Typed settings supported by Pi {settings.errors.length ? `(${settings.errors.length} load error)` : ''}</p></div>
            <Button size="sm" isLoading={busy === 'settings'} disabled={busy !== null} onClick={() => workspacePath && void run('settings', async () => {
              const saved = await patchPiSettings(workspacePath, {
                ...draft,
                defaultProvider: draft.defaultProvider?.trim() || undefined,
                defaultModel: draft.defaultModel?.trim() || undefined,
                shellPath: draft.shellPath?.trim() || null,
                theme: draft.theme?.trim() || undefined,
                httpProxy: draft.httpProxy?.trim() || null,
              })
              setSettings(saved)
              setDraft(draftFromSnapshot(saved))
            }, 'Runtime settings saved')}>Save</Button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Setting label="Default provider"><input className={inputClass} value={draft.defaultProvider} onChange={event => setDraft({ ...draft, defaultProvider: event.target.value })} /></Setting>
            <Setting label="Default model"><input className={inputClass} value={draft.defaultModel} onChange={event => setDraft({ ...draft, defaultModel: event.target.value })} /></Setting>
            <Setting label="Thinking"><select className={inputClass} value={draft.defaultThinkingLevel} onChange={event => setDraft({ ...draft, defaultThinkingLevel: event.target.value as SettingsDraft['defaultThinkingLevel'] })}><option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select></Setting>
            <Setting label="Transport"><select className={inputClass} value={draft.transport} onChange={event => setDraft({ ...draft, transport: event.target.value as SettingsDraft['transport'] })}><option>auto</option><option>sse</option><option>websocket</option><option>websocket-cached</option></select></Setting>
            <Setting label="Steering mode"><select className={inputClass} value={draft.steeringMode} onChange={event => setDraft({ ...draft, steeringMode: event.target.value as SettingsDraft['steeringMode'] })}><option value="all">all</option><option value="one-at-a-time">one-at-a-time</option></select></Setting>
            <Setting label="Follow-up mode"><select className={inputClass} value={draft.followUpMode} onChange={event => setDraft({ ...draft, followUpMode: event.target.value as SettingsDraft['followUpMode'] })}><option value="all">all</option><option value="one-at-a-time">one-at-a-time</option></select></Setting>
            <Setting label="Shell path"><input className={inputClass} value={draft.shellPath ?? ''} onChange={event => setDraft({ ...draft, shellPath: event.target.value })} /></Setting>
            <Setting label="Pi runtime theme"><input className={inputClass} value={draft.theme ?? ''} placeholder="Theme name" onChange={event => setDraft({ ...draft, theme: event.target.value })} /></Setting>
            <Setting label="HTTP proxy"><input className={inputClass} value={draft.httpProxy ?? ''} placeholder="http://127.0.0.1:7890" onChange={event => setDraft({ ...draft, httpProxy: event.target.value })} /></Setting>
            <Setting label="Default trust"><select className={inputClass} value={draft.defaultProjectTrust} onChange={event => setDraft({ ...draft, defaultProjectTrust: event.target.value as SettingsDraft['defaultProjectTrust'] })}><option>ask</option><option>always</option><option>never</option></select></Setting>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Toggle label="Compaction" checked={Boolean(draft.compactionEnabled)} onChange={checked => setDraft({ ...draft, compactionEnabled: checked })} />
            <Toggle label="Retry" checked={Boolean(draft.retryEnabled)} onChange={checked => setDraft({ ...draft, retryEnabled: checked })} />
            <Toggle label="Skill commands" checked={Boolean(draft.enableSkillCommands)} onChange={checked => setDraft({ ...draft, enableSkillCommands: checked })} />
            <Toggle label="Images" checked={Boolean(draft.showImages)} onChange={checked => setDraft({ ...draft, showImages: checked })} />
          </div>
          <details className="border-t border-border-100 pt-3 text-[length:var(--fs-xs)]">
            <summary className="cursor-pointer text-text-300">All effective settings and advanced patch</summary>
            <JsonScope title="Global scope" value={settings.global} />
            <JsonScope title="Project scope" value={settings.project} />
            <JsonScope title="Effective settings" value={settings.effective} />
            <label className="mt-3 block space-y-1"><span className="text-text-400">PiSettingsPatch JSON</span><textarea rows={7} className="w-full resize-y rounded-md border border-border-200 bg-bg-100 p-2 font-mono text-text-100" value={advancedPatch} onChange={event => setAdvancedPatch(event.target.value)} /></label>
            <div className="mt-2 flex justify-end"><Button size="sm" disabled={busy !== null} onClick={() => workspacePath && void run('advanced-settings', async () => {
              let patch: JsonObject
              try { patch = JSON.parse(advancedPatch) as JsonObject } catch { throw new Error('Settings patch must be valid JSON') }
              const saved = await patchPiSettings(workspacePath, patch)
              setSettings(saved)
              setDraft(draftFromSnapshot(saved))
              setAdvancedPatch('{}')
            }, 'Advanced settings patch saved')}>Apply patch</Button></div>
          </details>
        </section>
      ) : null}

      <PiProviderManagement />
      {workspacePath ? <PiPackageManagement workspacePath={workspacePath} /> : null}
      {workspacePath ? <PiResourceManagement sessionId={sessionId} workspacePath={workspacePath} /> : null}
      {workspacePath ? <PiSessionManagement sessionId={sessionId} workspacePath={workspacePath} /> : null}
    </div>
  )
}

function Setting({ label, children }: { label: string; children: ReactNode }) {
  return <label className="space-y-1"><span className="block text-[length:var(--fs-xs)] text-text-400">{label}</span>{children}</label>
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex min-h-8 items-center gap-2 text-[length:var(--fs-xs)] text-text-300"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />{label}</label>
}

function JsonScope({ title, value }: { title: string; value: unknown }) {
  return <details className="mt-2"><summary className="cursor-pointer text-text-300">{title}</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-bg-200/40 p-2 text-text-400">{JSON.stringify(value, null, 2)}</pre></details>
}
