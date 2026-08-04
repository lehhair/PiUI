import { useCallback, useEffect, useMemo, useState, memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '@earendil-works/pi-coding-agent'
import type { JsonObject, JsonValue } from '@piui/protocol'
import { Button } from '../../../components/ui/Button'
import {
  abortPiBashExecution,
  appendPiCustomEntry,
  cyclePiModel,
  cyclePiThinkingLevel,
  executePiBash,
  exportPiSession,
  loadPiSessionsForCwd,
  newPiSessionFrom,
  openPiSession,
  sendPiCustomMessage,
  sendPiPrompt,
  sendPiUserMessage,
  setPiScopedModels,
  waitForPiIdle,
} from '../../../pi/controllers/index.js'
import { usePiSessionRuntimeState } from '../../../pi/hooks/index.js'
import { Toggle, SettingsSection, SettingsSubgroup, SettingsSelect, SettingsDisclosure, settingsFieldClass, settingsFieldAreaClass } from './SettingsUI'

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function PiSessionManagement({ sessionId, workspacePath }: { sessionId: string | null; workspacePath: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const state = usePiSessionRuntimeState(sessionId)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [targetSessionPath, setTargetSessionPath] = useState('')
  const [scopedModels, setScopedModels] = useState('')
  const [bashCommand, setBashCommand] = useState('')
  const [bashResult, setBashResult] = useState<unknown>()
  const [bashExcludeFromContext, setBashExcludeFromContext] = useState(false)
  const [exportPath, setExportPath] = useState('')
  const [exportResult, setExportResult] = useState<unknown>()
  const [customType, setCustomType] = useState('')
  const [customPayload, setCustomPayload] = useState('{}')
  const [userMessage, setUserMessage] = useState('')
  const [deliveryMode, setDeliveryMode] = useState<'' | 'steer' | 'followUp'>('')
  const [promptText, setPromptText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const model = useMemo(() => record(state?.model), [state])
  const scopedModelPatterns = useMemo(
    () => (Array.isArray(state?.scopedModels) ? state.scopedModels.map(String) : []),
    [state],
  )

  const load = useCallback(async () => {
    try {
      const nextSessions = await loadPiSessionsForCwd(workspacePath)
      setSessions(nextSessions)
      setTargetSessionPath(current => current || nextSessions.find(item => item.id !== sessionId)?.path || '')
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId, workspacePath])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    setScopedModels(scopedModelPatterns.join('\n'))
  }, [scopedModelPatterns])

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
      <SettingsSection title={t('pi.sessionTitle')} description={t('pi.sessionOpenSession')}>
        {null}
      </SettingsSection>
    )
  }

  const enterSession = (targetId: string, directory?: string) => {
    const dir = directory ?? workspacePath
    window.location.hash = `#/session/${encodeURIComponent(targetId)}?dir=${encodeURIComponent(dir)}`
    window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
  }

  const parseJson = () => {
    try { return JSON.parse(customPayload) as JsonValue } catch { throw new Error(t('pi.invalidJson')) }
  }

  const stateLabel = state?.isStreaming ? t('pi.stateStreaming') : state ? t('pi.stateIdle') : t('pi.stateLoading')
  const modelLabel = typeof model.provider === 'string' ? `${model.provider}/${String(model.modelId ?? '')}` : t('pi.noModel')

  return (
    <SettingsSection title={t('pi.sessionTitle')} description={t('pi.sessionDescription')}>
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      <p className="text-[length:var(--fs-xs)] text-text-400">
        {t('pi.sessionState', { state: stateLabel, model: modelLabel, thinking: String(state?.thinkingLevel ?? 'unknown') })}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('new', async () => {
          const result = await newPiSessionFrom(sessionId)
          if (!result.cancelled && result.targetSessionId) enterSession(result.targetSessionId, result.targetCwd ?? undefined)
        })}>{t('pi.newNativeSession')}</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('cycle-model', () => cyclePiModel(sessionId))}>{t('pi.nextModel')}</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('cycle-thinking', () => cyclePiThinkingLevel(sessionId))}>{t('pi.cycleThinking')}</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('idle', () => waitForPiIdle(sessionId))}>{t('pi.waitForIdle')}</Button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <SettingsSelect
          ariaLabel={t('pi.switchSession')}
          value={targetSessionPath}
          onChange={setTargetSessionPath}
          options={sessions.filter(item => item.id !== sessionId).map(item => ({ value: item.path, label: item.name || item.firstMessage || item.id }))}
        />
        <Button size="sm" disabled={busy !== null || !targetSessionPath} onClick={() => void run('switch', async () => {
          const opened = await openPiSession(workspacePath, targetSessionPath)
          if (opened.sessionId) enterSession(opened.sessionId, opened.cwd ?? undefined)
        })}>{t('pi.switchSession')}</Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <input className={`${settingsFieldClass} min-w-44 flex-1`} value={userMessage} placeholder={t('pi.userMessagePlaceholder')} onChange={event => setUserMessage(event.target.value)} />
        <SettingsSelect
          ariaLabel={t('pi.nextTurn')}
          value={deliveryMode}
          onChange={setDeliveryMode}
          options={[
            { value: '' as const, label: t('pi.nextTurn') },
            { value: 'steer' as const, label: t('pi.steer') },
            { value: 'followUp' as const, label: t('pi.followUp') },
          ]}
        />
        <Button size="sm" disabled={busy !== null || !userMessage.trim()} onClick={() => void run('user-message', async () => { await sendPiUserMessage(sessionId, userMessage.trim(), undefined, deliveryMode || undefined); setUserMessage('') })}>{t('common:send')}</Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <input className={`${settingsFieldClass} min-w-44 flex-1`} value={promptText} placeholder={t('pi.promptPlaceholder')} onChange={event => setPromptText(event.target.value)} />
        <Button size="sm" disabled={busy !== null || !promptText.trim()} onClick={() => void run('prompt', async () => {
          await sendPiPrompt(sessionId, promptText.trim())
          setPromptText('')
        })}>{t('pi.prompt')}</Button>
      </div>

      <SettingsSubgroup title={t('pi.scopedModelsLabel')}>
        <textarea rows={3} className={`${settingsFieldAreaClass} font-mono`} value={scopedModels} onChange={event => setScopedModels(event.target.value)} />
        <div>
          <Button size="sm" disabled={busy !== null} onClick={() => void run('scoped-models', () => setPiScopedModels(sessionId, scopedModels.split(/\r?\n/).map(item => item.trim()).filter(Boolean)))}>{t('pi.applyModelScope')}</Button>
        </div>
      </SettingsSubgroup>

      <SettingsSubgroup title={t('pi.bashGroup')}>
        <div className="flex flex-wrap gap-2">
          <input className={`${settingsFieldClass} min-w-44 flex-1`} value={bashCommand} placeholder={t('pi.bashPlaceholder')} onChange={event => setBashCommand(event.target.value)} />
          <Button size="sm" disabled={busy !== null || !bashCommand.trim()} onClick={() => void run('bash', async () => setBashResult(await executePiBash(sessionId, bashCommand.trim(), bashExcludeFromContext)))}>{t('pi.runBash')}</Button>
          <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run('abort-bash', () => abortPiBashExecution(sessionId))}>{t('pi.abortBash')}</Button>
        </div>
        <div className="flex items-center gap-2">
          <Toggle enabled={bashExcludeFromContext} onChange={() => setBashExcludeFromContext(value => !value)} ariaLabel={t('pi.excludeBash')} />
          <span className="text-[length:var(--fs-xs)] text-text-300">{t('pi.excludeBash')}</span>
        </div>
        {bashResult !== undefined ? <ResultValue value={bashResult} /> : null}
      </SettingsSubgroup>

      <div className="flex flex-wrap gap-2">
        <input className={`${settingsFieldClass} min-w-44 flex-1`} value={exportPath} placeholder={t('pi.outputPath')} onChange={event => setExportPath(event.target.value)} />
        <Button size="sm" variant="secondary" disabled={busy !== null || !exportPath.trim()} onClick={() => void run('export-html', async () => setExportResult(await exportPiSession(sessionId, 'html', exportPath.trim())))}>{t('pi.exportHtml')}</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null || !exportPath.trim()} onClick={() => void run('export-jsonl', async () => setExportResult(await exportPiSession(sessionId, 'jsonl', exportPath.trim())))}>{t('pi.exportJsonl')}</Button>
      </div>
      {exportResult !== undefined ? <p className="break-all text-[length:var(--fs-xs)] text-text-300">{formatValue(exportResult)}</p> : null}
      <SettingsDisclosure title={t('pi.extensionHostCommands')}>
        <div className="space-y-2">
          <input className={settingsFieldClass} value={customType} placeholder={t('pi.customType')} onChange={event => setCustomType(event.target.value)} />
          <textarea rows={3} className={`${settingsFieldAreaClass} font-mono`} value={customPayload} onChange={event => setCustomPayload(event.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={busy !== null || !customType.trim()} onClick={() => void run('custom-message', async () => { const value = parseJson(); const content = [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }]; await sendPiCustomMessage(sessionId, { customType: customType.trim(), content, display: true }) })}>{t('pi.sendCustomMessage')}</Button>
            <Button size="sm" variant="secondary" disabled={busy !== null || !customType.trim()} onClick={() => void run('custom-entry', () => appendPiCustomEntry(sessionId, customType.trim(), parseJson()))}>{t('pi.appendCustomEntry')}</Button>
          </div>
        </div>
      </SettingsDisclosure>
    </SettingsSection>
  )
}

const ResultValue = memo(function ResultValue({ value }: { value: unknown }) {
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-bg-200/40 p-2 text-[length:var(--fs-xs)] text-text-300">{formatValue(value)}</pre>
  )
})

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}
