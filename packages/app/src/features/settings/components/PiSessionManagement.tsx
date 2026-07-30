import { useCallback, useEffect, useMemo, useState } from 'react'
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

const inputClass = 'h-8 w-full rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100'

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function PiSessionManagement({ sessionId, workspacePath }: { sessionId: string | null; workspacePath: string }) {
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

  if (!sessionId) return <section><h3 className="text-[length:var(--fs-sm)] font-medium text-text-100">Session commands</h3><p className="mt-1 text-[length:var(--fs-xs)] text-text-400">Open a session to use native Pi session commands.</p></section>

  const enterSession = (targetId: string, directory?: string) => {
    const dir = directory ?? workspacePath
    window.location.hash = `#/session/${encodeURIComponent(targetId)}?dir=${encodeURIComponent(dir)}`
    window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
  }

  const parseJson = () => {
    try { return JSON.parse(customPayload) as JsonValue } catch { throw new Error('Custom payload must be valid JSON') }
  }

  return (
    <section className="space-y-3">
      <div><h3 className="text-[length:var(--fs-sm)] font-medium text-text-100">Session commands</h3><p className="text-[length:var(--fs-xs)] text-text-400">Native session replacement, model scope, export, one-shot bash and extension host commands.</p></div>
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      <p className="text-[length:var(--fs-xs)] text-text-400">State: {state?.isStreaming ? 'streaming' : state ? 'idle' : 'loading'} · model: {typeof model.provider === 'string' ? `${model.provider}/${String(model.modelId ?? '')}` : 'none'} · thinking: {String(state?.thinkingLevel ?? 'unknown')}</p>

      <div className="flex flex-wrap gap-2 border-y border-border-100 py-2">
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('new', async () => {
          const result = await newPiSessionFrom(sessionId)
          if (!result.cancelled && result.targetSessionId) enterSession(result.targetSessionId, result.targetCwd ?? undefined)
        })}>New native session</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('cycle-model', () => cyclePiModel(sessionId))}>Next model</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('cycle-thinking', () => cyclePiThinkingLevel(sessionId))}>Cycle thinking</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('idle', () => waitForPiIdle(sessionId))}>Wait for idle</Button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <select className={inputClass} value={targetSessionPath} onChange={event => setTargetSessionPath(event.target.value)}>{sessions.filter(item => item.id !== sessionId).map(item => <option key={item.id} value={item.path}>{item.name || item.firstMessage || item.id}</option>)}</select>
        <Button size="sm" disabled={busy !== null || !targetSessionPath} onClick={() => void run('switch', async () => {
          const opened = await openPiSession(workspacePath, targetSessionPath)
          if (opened.sessionId) enterSession(opened.sessionId, opened.cwd ?? undefined)
        })}>Switch native session</Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <input className={`${inputClass} min-w-44 flex-1`} value={userMessage} placeholder="Send user message through native Pi API" onChange={event => setUserMessage(event.target.value)} />
        <select className="h-8 rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-xs)] text-text-200" value={deliveryMode} onChange={event => setDeliveryMode(event.target.value as typeof deliveryMode)}><option value="">Next turn</option><option value="steer">Steer</option><option value="followUp">Follow-up</option></select>
        <Button size="sm" disabled={busy !== null || !userMessage.trim()} onClick={() => void run('user-message', async () => { await sendPiUserMessage(sessionId, userMessage.trim(), undefined, deliveryMode || undefined); setUserMessage('') })}>Send</Button>
      </div>

      <div className="space-y-2 border-t border-border-100 pt-3">
        <div className="flex flex-wrap gap-2">
          <input className={`${inputClass} min-w-44 flex-1`} value={promptText} placeholder="Prompt through AgentSession.prompt" onChange={event => setPromptText(event.target.value)} />
          <Button size="sm" disabled={busy !== null || !promptText.trim()} onClick={() => void run('prompt', async () => {
            await sendPiPrompt(sessionId, promptText.trim())
            setPromptText('')
          })}>Prompt</Button>
        </div>
      </div>

      <label className="block space-y-1"><span className="text-[length:var(--fs-xs)] text-text-400">Scoped model patterns, one per line</span><textarea rows={3} className="w-full resize-y rounded-md border border-border-200 bg-bg-100 p-2 font-mono text-[length:var(--fs-xs)] text-text-100" value={scopedModels} onChange={event => setScopedModels(event.target.value)} /></label>
      <Button size="sm" disabled={busy !== null} onClick={() => void run('scoped-models', () => setPiScopedModels(sessionId, scopedModels.split(/\r?\n/).map(item => item.trim()).filter(Boolean)))}>Apply model scope</Button>

      <div className="space-y-2 border-t border-border-100 pt-3"><div className="flex flex-wrap gap-2"><input className={`${inputClass} min-w-44 flex-1`} value={bashCommand} placeholder="One-shot bash command" onChange={event => setBashCommand(event.target.value)} /><Button size="sm" disabled={busy !== null || !bashCommand.trim()} onClick={() => void run('bash', async () => setBashResult(await executePiBash(sessionId, bashCommand.trim(), bashExcludeFromContext)))}>Run</Button><Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run('abort-bash', () => abortPiBashExecution(sessionId))}>Abort</Button></div><Toggle label="Exclude bash output from session context" checked={bashExcludeFromContext} onChange={setBashExcludeFromContext} /></div>
      {bashResult !== undefined ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-bg-200/40 p-2 text-[length:var(--fs-xs)] text-text-300">{formatValue(bashResult)}</pre> : null}

      <div className="flex flex-wrap gap-2"><input className={`${inputClass} min-w-44 flex-1`} value={exportPath} placeholder="Optional output path" onChange={event => setExportPath(event.target.value)} /><Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('export-html', async () => setExportResult(await exportPiSession(sessionId, 'html', exportPath.trim() || undefined)))}>Export HTML</Button><Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('export-jsonl', async () => setExportResult(await exportPiSession(sessionId, 'jsonl', exportPath.trim() || undefined)))}>Export JSONL</Button></div>
      {exportResult !== undefined ? <p className="break-all text-[length:var(--fs-xs)] text-text-300">{formatValue(exportResult)}</p> : null}

      <details className="border-t border-border-100 pt-3 text-[length:var(--fs-xs)]"><summary className="cursor-pointer text-text-300">Extension host commands</summary><div className="mt-2 space-y-2"><input className={inputClass} value={customType} placeholder="Custom type" onChange={event => setCustomType(event.target.value)} /><textarea rows={3} className="w-full rounded-md border border-border-200 bg-bg-100 p-2 font-mono text-text-100" value={customPayload} onChange={event => setCustomPayload(event.target.value)} /><div className="flex gap-2"><Button size="sm" variant="secondary" disabled={busy !== null || !customType.trim()} onClick={() => void run('custom-message', async () => { const value = parseJson(); const content = [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }]; await sendPiCustomMessage(sessionId, { customType: customType.trim(), content, display: true }) })}>Send custom message</Button><Button size="sm" variant="secondary" disabled={busy !== null || !customType.trim()} onClick={() => void run('custom-entry', () => appendPiCustomEntry(sessionId, customType.trim(), parseJson()))}>Append custom entry</Button></div></div></details>
    </section>
  )
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex min-h-8 items-center gap-2 text-[length:var(--fs-xs)] text-text-300"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />{label}</label>
}
