import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { RetryIcon, SpinnerIcon, StopIcon, WifiIcon, WifiOffIcon } from '../../../components/Icons'
import { settingsFieldClass, SettingsSection } from './SettingsUI'
import { isTauri, isTauriMobile } from '../../../utils/tauri'

interface ServiceStatus {
  running: boolean
  startedByUs: boolean
  pid?: number | null
  url?: string | null
  environment: Record<string, string>
}

export function ServiceSettings() {
  const { t } = useTranslation(['settings', 'common'])
  const desktop = isTauri() && !isTauriMobile()
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [busy, setBusy] = useState<'refresh' | 'stop' | 'restart' | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!desktop) return
    setBusy('refresh')
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      setStatus(await invoke<ServiceStatus>('get_piui_service_status'))
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(null)
    }
  }, [desktop])

  const run = useCallback(async (operation: 'stop' | 'restart') => {
    setBusy(operation)
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      if (operation === 'stop') await invoke('stop_piui_service')
      else await invoke('restart_piui_service')
      await refresh()
    } catch (reason) {
      setError(String(reason))
      setBusy(null)
    }
  }, [refresh])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!desktop) {
    return (
      <SettingsSection title={t('service.title')} description={t('service.desktopOnly')}>
        <div />
      </SettingsSection>
    )
  }

  const running = status?.running === true
  const owned = status?.startedByUs === true

  return (
    <SettingsSection
      title={t('service.title')}
      description={t('service.description')}
      actions={
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-400 hover:bg-bg-200/70 hover:text-text-200 disabled:opacity-40"
          onClick={() => void refresh()}
          disabled={busy !== null}
          title={t('common:refresh')}
          aria-label={t('common:refresh')}
        >
          <RetryIcon size={14} />
        </button>
      }
    >
      <div className="flex items-start justify-between gap-3 rounded-lg border border-border-200/50 bg-bg-100 p-3">
        <div className="flex min-w-0 items-start gap-2">
          {busy === 'refresh' || busy === 'restart' ? (
            <SpinnerIcon size={15} className="mt-0.5 animate-spin text-text-400" />
          ) : running ? (
            <WifiIcon size={15} className="mt-0.5 text-success-100" />
          ) : (
            <WifiOffIcon size={15} className="mt-0.5 text-text-400" />
          )}
          <div className="min-w-0">
            <div className="text-[length:var(--fs-md)] font-medium text-text-100">
              {running ? t('service.running') : t('service.stopped')}
            </div>
            <div className="mt-1 break-all text-[length:var(--fs-xs)] leading-relaxed text-text-400">
              {running
                ? owned
                  ? t('service.startedByApp')
                  : t('service.startedExternally')
                : t('service.notRunning')}
              {status?.pid ? ` · PID ${status.pid}` : ''}
            </div>
            {status?.url && <div className="mt-1 break-all font-mono text-[length:var(--fs-xs)] text-text-500">{status.url}</div>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {running && owned && (
            <Button size="sm" variant="ghost" onClick={() => void run('stop')} disabled={busy !== null}>
              <StopIcon size={12} className="mr-1" />
              {t('common:stop')}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void run('restart')}
            disabled={busy !== null || (running && !owned)}
          >
            <RetryIcon size={12} className="mr-1" />
            {t('service.restart')}
          </Button>
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 text-[length:var(--fs-xs)] font-medium text-text-300">{t('service.environment')}</div>
        <div className="grid gap-1 rounded-lg border border-border-200/50 bg-bg-100 p-2">
          {Object.entries(status?.environment ?? {}).map(([key, value]) => (
            <div key={key} className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-2 font-mono text-[length:var(--fs-xxs)]">
              <span className="text-text-300">{key}</span>
              <span className={`${settingsFieldClass} min-w-0 truncate text-text-500`} title={value}>{value}</span>
            </div>
          ))}
        </div>
      </div>
      {error && <p className="mt-2 break-all text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
    </SettingsSection>
  )
}
