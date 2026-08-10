import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TerminalShell } from '@piui/protocol'
import { Button } from '../../../components/ui/Button'
import { RetryIcon, SpinnerIcon, StopIcon, TrashIcon, WifiIcon, WifiOffIcon } from '../../../components/Icons'
import { isTauri, isTauriMobile } from '../../../utils/tauri'
import { SERVICE_ENV_EXAMPLES, serviceStore, useServiceStore } from '../../../store/serviceStore'
import {
  refreshDesktopServiceStatus,
  restartDesktopService,
  startDesktopService,
  stopDesktopService,
  type DesktopServiceStatus,
} from '../../../services/desktopService'
import { listHostShells } from '../../../pi/transport/index.js'
import { serverStorage } from '../../../utils'
import { useServerStore } from '../../../hooks'
import { settingsFieldClass, SettingField, SettingRow, SettingsSection, SettingsSelect, Toggle } from './SettingsUI'

const TERMINAL_SHELL_STORAGE_KEY = 'piui-terminal-shell'
const LISTEN_HOST_KEY = 'PIUI_HOST'
const LISTEN_PORT_KEY = 'PIUI_PORT'

export function ServiceSettings() {
  const { t } = useTranslation(['settings', 'common'])
  const desktop = isTauri() && !isTauriMobile()
  const { activeServerGeneration } = useServerStore()
  const { autoStart, useSystemPiSdk, envVars, running, startedByUs, starting } = useServiceStore()
  const [status, setStatus] = useState<DesktopServiceStatus | null>(null)
  const [shells, setShells] = useState<TerminalShell[]>([])
  const [selectedShell, setSelectedShell] = useState('')
  const [shellsLoading, setShellsLoading] = useState(false)
  const [busy, setBusy] = useState<'refresh' | 'stop' | 'start' | 'restart' | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!desktop) return
    setBusy('refresh')
    setError('')
    try {
      const next = await refreshDesktopServiceStatus()
      setStatus(next)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(null)
    }
  }, [desktop])

  const start = useCallback(
    async (operation: 'start' | 'restart') => {
      setBusy(operation)
      setError('')
      try {
        const outcome = await (operation === 'start' ? startDesktopService() : restartDesktopService())
        setStatus(outcome.status)
      } catch (reason) {
        setError(String(reason))
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  const stop = useCallback(async () => {
    setBusy('stop')
    setError('')
    try {
      setStatus(await stopDesktopService())
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  // 加载主机 shells：请求-响应模式，loading/选中值需与请求同步设置
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let cancelled = false
    setSelectedShell(serverStorage.get(TERMINAL_SHELL_STORAGE_KEY) ?? '')
    setShellsLoading(true)
    void listHostShells()
      .then(result => {
        if (!cancelled) setShells(result.shells)
      })
      .catch(() => {
        if (!cancelled) setShells([])
      })
      .finally(() => {
        if (!cancelled) setShellsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeServerGeneration, desktop, running])

  const shellOptions = useMemo(() => {
    const nameCounts = new Map<string, number>()
    for (const shell of shells) nameCounts.set(shell.name, (nameCounts.get(shell.name) ?? 0) + 1)
    const options = [
      { value: '', label: t('service.terminalShellAuto') },
      ...shells.map(shell => ({
        value: shell.path,
        label: `${nameCounts.get(shell.name) === 1 ? shell.name : shell.path}${shell.acceptable ? '' : ` (${t('service.terminalShellOnly')})`}`,
      })),
    ]
    if (selectedShell && !options.some(option => option.value === selectedShell)) {
      options.push({ value: selectedShell, label: selectedShell })
    }
    return options
  }, [selectedShell, shells, t])

  const terminalShell = (
    <SettingField label={t('service.terminalShell')} description={t('service.terminalShellDesc')}>
      <SettingsSelect
        ariaLabel={t('service.terminalShell')}
        value={selectedShell}
        options={shellOptions}
        disabled={shellsLoading || shellOptions.length <= 1}
        onChange={value => {
          setSelectedShell(value)
          if (value) serverStorage.set(TERMINAL_SHELL_STORAGE_KEY, value)
          else serverStorage.remove(TERMINAL_SHELL_STORAGE_KEY)
        }}
      />
    </SettingField>
  )

  const listenHost = serviceStore.envVars.find(item => item.key.trim().toUpperCase() === LISTEN_HOST_KEY)?.value.trim() || '127.0.0.1'
  const listenPort = serviceStore.envVars.find(item => item.key.trim().toUpperCase() === LISTEN_PORT_KEY)?.value.trim() || '8787'
  const listenSettings = (
    <SettingsSection title={t('service.listenTitle')} description={t('service.listenDesc')}>
      <SettingField label={t('service.listenHost')} description={t('service.listenHostDesc')}>
        <SettingsSelect
          ariaLabel={t('service.listenHost')}
          value={listenHost}
          options={[
            { value: '127.0.0.1', label: t('service.listenHostLocal') },
            { value: '0.0.0.0', label: t('service.listenHostLan') },
            { value: '::', label: t('service.listenHostAll') },
          ]}
          onChange={value => serviceStore.upsertEnvVar(LISTEN_HOST_KEY, value)}
        />
      </SettingField>
      <SettingField label={t('service.listenPort')} description={t('service.listenPortDesc')}>
        <input
          type="number"
          min={1}
          max={65535}
          inputMode="numeric"
          value={listenPort}
          aria-label={t('service.listenPort')}
          className={`${settingsFieldClass} w-28`}
          onChange={event => {
            const value = event.target.value.replace(/\D/g, '').slice(0, 5)
            if (value) serviceStore.upsertEnvVar(LISTEN_PORT_KEY, value)
            else serviceStore.setEnvVars(serviceStore.envVars.filter(item => item.key.trim().toUpperCase() !== LISTEN_PORT_KEY))
          }}
        />
      </SettingField>
      <div className="text-[length:var(--fs-xs)] leading-relaxed text-warning-100/80">
        {t('service.listenRestartHint')}
      </div>
    </SettingsSection>
  )

  if (!desktop) {
    return (
      <>
        <SettingsSection title={t('service.title')} description={t('service.desktopOnly')}>
          <div className="text-[length:var(--fs-xs)] leading-relaxed text-text-300">{t('service.webModeDesc')}</div>
        </SettingsSection>
        {listenSettings}
        <SettingsSection title={t('service.terminalTitle')} description={t('service.terminalTitleDesc')}>
          {terminalShell}
        </SettingsSection>
      </>
    )
  }

  const isBusy = busy !== null || starting
  const serviceEnvironment = status?.environment ?? {}

  return (
    <>
      {listenSettings}
      <SettingsSection
        title={t('service.title')}
        description={t('service.description')}
        actions={
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-400 hover:bg-bg-200/70 hover:text-text-200 disabled:opacity-40"
          onClick={() => void refresh()}
          disabled={isBusy}
          title={t('common:refresh')}
          aria-label={t('common:refresh')}
        >
          <RetryIcon size={14} />
        </button>
        }
      >
      {terminalShell}

      <SettingRow
        label={t('service.autoStart')}
        description={t('service.autoStartDesc')}
        onClick={() => serviceStore.setAutoStart(!autoStart)}
      >
        <Toggle enabled={autoStart} onChange={() => serviceStore.setAutoStart(!autoStart)} />
      </SettingRow>

      <SettingRow
        label={t('service.useSystemPiSdk')}
        description={t('service.useSystemPiSdkDesc')}
        onClick={() => serviceStore.setUseSystemPiSdk(!useSystemPiSdk)}
      >
        <Toggle enabled={useSystemPiSdk} onChange={() => serviceStore.setUseSystemPiSdk(!useSystemPiSdk)} />
      </SettingRow>

      <SettingRow
        label={t('service.serviceStatus')}
        description={
          starting
            ? t('service.starting')
            : running
              ? startedByUs
                ? t('service.startedByApp')
                : t('service.startedExternally')
              : t('service.notRunning')
        }
        icon={
          starting || busy === 'refresh' || busy === 'restart' ? (
            <SpinnerIcon size={14} className="animate-spin text-text-400" />
          ) : running ? (
            <WifiIcon size={14} className="text-success-100" />
          ) : (
            <WifiOffIcon size={14} className="text-text-400" />
          )
        }
      >
        <div className="flex items-center gap-1.5">
          {!running && !isBusy && (
            <Button size="sm" variant="ghost" onClick={() => void start('start')}>
              {t('common:start')}
            </Button>
          )}
          {running && startedByUs && (
            <Button size="sm" variant="ghost" onClick={() => void stop()} disabled={isBusy}>
              <StopIcon size={12} className="mr-1" />
              {t('common:stop')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void start('restart')}
            disabled={isBusy || (running && !startedByUs)}
          >
            <RetryIcon size={12} className="mr-1" />
            {t('service.restart')}
          </Button>
        </div>
      </SettingRow>

      {status?.url && (
        <div className="break-all font-mono text-[length:var(--fs-xs)] text-text-500">
          {status.url}
          {status.pid ? ` · PID ${status.pid}` : ''}
        </div>
      )}

      <SettingField
        label={t('service.envVars')}
        description={t('service.envVarsDesc')}
        actions={
          <div className="flex min-w-0 items-center gap-1.5">
            <select
              value=""
              onChange={event => {
                const example = SERVICE_ENV_EXAMPLES.find(item => item.key === event.target.value)
                if (example) serviceStore.upsertEnvVar(example.key, example.value)
              }}
              className={`${settingsFieldClass} h-7 max-w-44 py-0 font-mono text-[length:var(--fs-xxs)]`}
              aria-label={t('service.addExample')}
            >
              <option value="">{t('service.addExample')}</option>
              {SERVICE_ENV_EXAMPLES.map(example => (
                <option key={example.key} value={example.key}>
                  {example.key}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="h-7 shrink-0 rounded-md px-2 text-[length:var(--fs-xs)] font-medium text-accent-main-100 transition-colors hover:bg-accent-main-100/10"
              onClick={() => serviceStore.setEnvVars([...envVars, { key: '', value: '' }])}
            >
              + {t('common:add')}
            </button>
          </div>
        }
      >
        {envVars.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {envVars.map((env, index) => (
              <div
                key={`${index}-${env.key}`}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1.5fr)_auto] items-center gap-1.5"
              >
                <input
                  value={env.key}
                  onChange={event => {
                    const next = [...envVars]
                    next[index] = { ...next[index], key: event.target.value }
                    serviceStore.setEnvVars(next)
                  }}
                  placeholder={t('service.keyPlaceholder')}
                  className={`${settingsFieldClass} min-w-0 font-mono text-[length:var(--fs-xs)]`}
                />
                <span className="text-[length:var(--fs-xs)] text-text-500">=</span>
                <input
                  value={env.value}
                  onChange={event => {
                    const next = [...envVars]
                    next[index] = { ...next[index], value: event.target.value }
                    serviceStore.setEnvVars(next)
                  }}
                  placeholder={t('service.valuePlaceholder')}
                  className={`${settingsFieldClass} min-w-0 font-mono text-[length:var(--fs-xs)]`}
                />
                <button
                  type="button"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-400 transition-colors hover:bg-danger-100/10 hover:text-danger-100"
                  onClick={() => serviceStore.setEnvVars(envVars.filter((_, itemIndex) => itemIndex !== index))}
                  title={t('common:remove')}
                  aria-label={t('common:remove')}
                >
                  <TrashIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingField>

      <SettingField label={t('service.environment')} description={t('service.environmentDesc')}>
        <div className="grid gap-1 rounded-lg border border-border-200/50 bg-bg-100 p-2">
          {Object.entries(serviceEnvironment).map(([key, value]) => (
            <div
              key={key}
              className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-2 font-mono text-[length:var(--fs-xxs)]"
            >
              <span className="text-text-300">{key}</span>
              <span className="min-w-0 truncate text-text-500" title={value}>
                {value}
              </span>
            </div>
          ))}
        </div>
      </SettingField>

      {error && <p className="break-all text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      </SettingsSection>
    </>
  )
}
