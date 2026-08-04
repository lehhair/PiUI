import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { JsonObject } from '@piui/protocol'
import type { PiProjectTrust, PiSettingsSnapshot } from '../../../pi/domain'
import type { HostWorkspace } from '../../../pi/workspaces'
import { Button } from '../../../components/ui/Button'
import { JsonView } from '../../../components/JsonView'
import { useCurrentDirectory } from '../../../hooks'
import { useFocusedSessionId } from '../../../pi/hooks/index.js'
import {
  getPiSettings,
  getProjectTrust,
  patchPiSettings,
  setProjectTrust,
} from '../../../pi/transport/index.js'
import { listHostWorkspaces, resolveWorkspacePath } from '../../../pi/workspaces'
import {
  Toggle,
  SettingRow,
  SettingField,
  SettingsSection,
  SettingsSelect,
  SettingsDisclosure,
  settingsFieldClass,
  settingsFieldAreaClass,
} from './SettingsUI'
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
  const { t } = useTranslation(['settings', 'common'])
  const directory = useCurrentDirectory()
  const sessionId = useFocusedSessionId()
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
      setError(loadError instanceof Error ? loadError.message : t('pi.loadFailed'))
    }
  }, [directory, t])

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
      setError(actionError instanceof Error ? actionError.message : t('pi.operationFailed'))
    } finally {
      setBusy(null)
    }
  }, [t])

  if (!directory) return <p className="text-[length:var(--fs-sm)] text-text-300">{t('pi.openWorkspace')}</p>

  const trustStatus = trust?.trusted
    ? t('pi.trusted')
    : trust?.decision === false
      ? t('pi.notTrusted')
      : t('pi.decisionRequired')

  return (
    <div className="pb-6">
      <header className="mb-8">
        <h2 className="text-[length:var(--fs-lg)] font-medium text-text-100">{t('pi.title')}</h2>
        <p className="mt-1 text-[length:var(--fs-xs)] text-text-400 break-all">{workspacePath ?? directory}</p>
        <SettingsDisclosure title={t('pi.registeredWorkspaces', { count: registeredWorkspaces.length })} className="mt-2 text-[length:var(--fs-xs)] text-text-400">
          <div className="max-h-32 overflow-auto border-l border-border-200 pl-2">
            {registeredWorkspaces.map(workspace => (
              <p key={workspace.path} className="truncate" title={workspace.path}>{workspace.displayName} · {workspace.path}</p>
            ))}
          </div>
        </SettingsDisclosure>
      </header>

      {error ? <p role="alert" className="mb-4 text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      {notice ? <p className="mb-4 text-[length:var(--fs-xs)] text-success-100">{notice}</p> : null}

      <SettingsSection title={t('pi.trustTitle')} description={t('pi.trustDescription')}>
        <SettingRow label={trustStatus}>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => workspacePath && void run('trust-reset', async () => setTrust(await setProjectTrust(workspacePath, null)), t('pi.trustReset'))}>{t('common:reset')}</Button>
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => workspacePath && void run('trust-deny', async () => setTrust(await setProjectTrust(workspacePath, false)), t('pi.trustDenied'))}>{t('pi.denyAction')}</Button>
            <Button size="sm" disabled={busy !== null} onClick={() => workspacePath && void run('trust-allow', async () => setTrust(await setProjectTrust(workspacePath, true)), t('pi.trustGranted'))}>{t('pi.trustAction')}</Button>
          </div>
        </SettingRow>
        {trust ? (
          <p className="text-[length:var(--fs-xs)] text-text-400">
            {t('pi.trustDetails', {
              required: String(trust.required),
              decision: trust.decision === null ? t('pi.decisionNone') : String(trust.decision),
              default: trust.defaultDecision,
            })}
            {trust.inheritedFrom ? t('pi.trustInherited', { source: trust.inheritedFrom }) : ''}
          </p>
        ) : null}
      </SettingsSection>

      {settings && draft ? (
        <SettingsSection
          title={t('pi.runtimeTitle')}
          description={`${t('pi.runtimeDescription')}${settings.errors.length ? ` (${t('pi.loadError', { count: settings.errors.length })})` : ''}`}
          actions={
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
            }, t('pi.settingsSaved'))}>{t('common:save')}</Button>
          }
        >
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <SettingField label={t('pi.defaultProvider')}>
              <input className={settingsFieldClass} aria-label={t('pi.defaultProvider')} value={draft.defaultProvider} onChange={event => setDraft({ ...draft, defaultProvider: event.target.value })} />
            </SettingField>
            <SettingField label={t('pi.defaultModel')}>
              <input className={settingsFieldClass} aria-label={t('pi.defaultModel')} value={draft.defaultModel} onChange={event => setDraft({ ...draft, defaultModel: event.target.value })} />
            </SettingField>
            <SettingField label={t('pi.thinking')}>
              <SettingsSelect ariaLabel={t('pi.thinking')} value={draft.defaultThinkingLevel} onChange={value => setDraft({ ...draft, defaultThinkingLevel: value })} options={(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(level => ({ value: level, label: level }))} />
            </SettingField>
            <SettingField label={t('pi.transport')}>
              <SettingsSelect ariaLabel={t('pi.transport')} value={draft.transport} onChange={value => setDraft({ ...draft, transport: value })} options={(['auto', 'sse', 'websocket', 'websocket-cached'] as const).map(transport => ({ value: transport, label: transport }))} />
            </SettingField>
            <SettingField label={t('pi.steeringMode')}>
              <SettingsSelect ariaLabel={t('pi.steeringMode')} value={draft.steeringMode} onChange={value => setDraft({ ...draft, steeringMode: value })} options={(['all', 'one-at-a-time'] as const).map(mode => ({ value: mode, label: mode }))} />
            </SettingField>
            <SettingField label={t('pi.followUpMode')}>
              <SettingsSelect ariaLabel={t('pi.followUpMode')} value={draft.followUpMode} onChange={value => setDraft({ ...draft, followUpMode: value })} options={(['all', 'one-at-a-time'] as const).map(mode => ({ value: mode, label: mode }))} />
            </SettingField>
            <SettingField label={t('pi.shellPath')}>
              <input className={settingsFieldClass} aria-label={t('pi.shellPath')} value={draft.shellPath ?? ''} onChange={event => setDraft({ ...draft, shellPath: event.target.value })} />
            </SettingField>
            <SettingField label={t('pi.runtimeTheme')}>
              <input className={settingsFieldClass} aria-label={t('pi.runtimeTheme')} value={draft.theme ?? ''} placeholder={t('pi.themeNamePlaceholder')} onChange={event => setDraft({ ...draft, theme: event.target.value })} />
            </SettingField>
            <SettingField label={t('pi.httpProxy')}>
              <input className={settingsFieldClass} aria-label={t('pi.httpProxy')} value={draft.httpProxy ?? ''} placeholder="http://127.0.0.1:7890" onChange={event => setDraft({ ...draft, httpProxy: event.target.value })} />
            </SettingField>
            <SettingField label={t('pi.defaultTrust')}>
              <SettingsSelect ariaLabel={t('pi.defaultTrust')} value={draft.defaultProjectTrust} onChange={value => setDraft({ ...draft, defaultProjectTrust: value })} options={(['ask', 'always', 'never'] as const).map(trust => ({ value: trust, label: trust }))} />
            </SettingField>
          </div>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            <SettingRow label={t('pi.compaction')}><Toggle enabled={Boolean(draft.compactionEnabled)} onChange={() => setDraft({ ...draft, compactionEnabled: !draft.compactionEnabled })} /></SettingRow>
            <SettingRow label={t('pi.retry')}><Toggle enabled={Boolean(draft.retryEnabled)} onChange={() => setDraft({ ...draft, retryEnabled: !draft.retryEnabled })} /></SettingRow>
            <SettingRow label={t('pi.skillCommands')}><Toggle enabled={Boolean(draft.enableSkillCommands)} onChange={() => setDraft({ ...draft, enableSkillCommands: !draft.enableSkillCommands })} /></SettingRow>
            <SettingRow label={t('pi.images')}><Toggle enabled={Boolean(draft.showImages)} onChange={() => setDraft({ ...draft, showImages: !draft.showImages })} /></SettingRow>
          </div>
          <SettingsDisclosure title={t('pi.advancedSummary')}>
            <SettingsDisclosure title={t('pi.globalScope')} className="mt-1"><JsonValue value={settings.global} /></SettingsDisclosure>
            <SettingsDisclosure title={t('pi.projectScope')} className="mt-1"><JsonValue value={settings.project} /></SettingsDisclosure>
            <SettingsDisclosure title={t('pi.effectiveSettings')} className="mt-1"><JsonValue value={settings.effective} /></SettingsDisclosure>
            <label className="mt-3 block space-y-1">
              <span className="text-[length:var(--fs-xs)] text-text-400">{t('pi.patchLabel')}</span>
              <textarea rows={7} className={`${settingsFieldAreaClass} font-mono`} value={advancedPatch} onChange={event => setAdvancedPatch(event.target.value)} />
            </label>
            <div className="mt-2 flex justify-end">
              <Button size="sm" disabled={busy !== null} onClick={() => workspacePath && void run('advanced-settings', async () => {
                let patch: JsonObject
                try { patch = JSON.parse(advancedPatch) as JsonObject } catch { throw new Error(t('pi.patchInvalidJson')) }
                const saved = await patchPiSettings(workspacePath, patch)
                setSettings(saved)
                setDraft(draftFromSnapshot(saved))
                setAdvancedPatch('{}')
              }, t('pi.patchSaved'))}>{t('pi.applyPatch')}</Button>
            </div>
          </SettingsDisclosure>
        </SettingsSection>
      ) : null}

      <PiProviderManagement />
      {workspacePath ? <PiPackageManagement workspacePath={workspacePath} /> : null}
      {workspacePath ? <PiResourceManagement sessionId={sessionId} workspacePath={workspacePath} /> : null}
      {workspacePath ? <PiSessionManagement sessionId={sessionId} workspacePath={workspacePath} /> : null}
    </div>
  )
}

function JsonValue({ value }: { value: unknown }) {
  return <JsonView value={value} className="max-h-64" />
}
