import { useCallback, useEffect, useState } from 'react'
import type { SessionSnapshotV1 } from '@piui/protocol'
import { Button } from '../../../components/ui/Button'
import { applySnapshotToUi } from '../../../pi/applySnapshot'
import {
  abortPiBash,
  appendPiCustomEntry,
  createNativePiSession,
  cyclePiSessionModel,
  cyclePiThinkingLevel,
  executePiBash,
  exportPiSession,
  fetchSnapshot,
  listPiSessions,
  listPiSessionModels,
  sendPiCustomMessage,
  sendPiUserMessage,
  setPiScopedModels,
  switchNativePiSession,
  waitForPiSessionIdle,
  type SessionReplacementResponse,
} from '../../../pi/sessionApi'
import type { PiSessionSummary } from '../../../types/session'

const inputClass = 'h-8 w-full rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100'

export function PiSessionManagement({ sessionId, workspacePath }: { sessionId: string | null; workspacePath: string }) {
  const [snapshot, setSnapshot] = useState<SessionSnapshotV1 | null>(null)
  const [sessions, setSessions] = useState<PiSessionSummary[]>([])
  const [sessionModels, setSessionModels] = useState<Awaited<ReturnType<typeof listPiSessionModels>>>([])
  const [targetSessionId, setTargetSessionId] = useState('')
  const [scopedModels, setScopedModels] = useState('')
  const [bashCommand, setBashCommand] = useState('')
  const [bashResult, setBashResult] = useState<unknown>()
  const [exportPath, setExportPath] = useState('')
  const [exportResult, setExportResult] = useState<unknown>()
  const [customType, setCustomType] = useState('')
  const [customPayload, setCustomPayload] = useState('{}')
  const [userMessage, setUserMessage] = useState('')
  const [deliveryMode, setDeliveryMode] = useState<'' | 'steer' | 'followUp'>('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!sessionId) return
    try {
      const [nextSnapshot, nextSessions, nextModels] = await Promise.all([
        fetchSnapshot(sessionId),
        listPiSessions(workspacePath),
        listPiSessionModels(sessionId),
      ])
      setSnapshot(nextSnapshot)
      setSessions(nextSessions)
      setSessionModels(nextModels)
      setScopedModels(nextSnapshot.runtime.scopedModels?.map(model => `${model.provider}/${model.id}`).join('\n') ?? '')
      setTargetSessionId(current => current || nextSessions.find(item => item.id !== sessionId)?.id || '')
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId, workspacePath])

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

  if (!sessionId) return <section><h3 className="text-[length:var(--fs-sm)] font-medium text-text-100">Session commands</h3><p className="mt-1 text-[length:var(--fs-xs)] text-text-400">Open a session to use native Pi session commands.</p></section>

  const applyReplacement = (result: SessionReplacementResponse<'session.new' | 'session.switch'>) => {
    applySnapshotToUi(result.sourceSnapshot, { activate: false })
    applySnapshotToUi(result.targetSnapshot)
    if (!result.replacement.cancelled) {
      const directory = result.replacement.targetCwd ?? result.targetSnapshot.session.directory
      window.location.hash = `#/session/${encodeURIComponent(result.replacement.targetSessionId)}?dir=${encodeURIComponent(directory)}`
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
    }
  }

  const parseJson = () => {
    try { return JSON.parse(customPayload) as unknown } catch { throw new Error('Custom payload must be valid JSON') }
  }

  return (
    <section className="space-y-3">
      <div><h3 className="text-[length:var(--fs-sm)] font-medium text-text-100">Session commands</h3><p className="text-[length:var(--fs-xs)] text-text-400">Native session replacement, model scope, export, one-shot bash and extension host commands.</p></div>
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      <p className="text-[length:var(--fs-xs)] text-text-400">State: {snapshot?.session.state ?? 'loading'} · model: {snapshot?.runtime.model ? `${snapshot.runtime.model.provider}/${snapshot.runtime.model.id}` : 'none'} · thinking: {snapshot?.runtime.thinkingLevel ?? 'unknown'}</p>
      <details className="text-[length:var(--fs-xs)]"><summary className="cursor-pointer text-text-300">Session models ({sessionModels.length})</summary><div className="mt-1 max-h-44 overflow-auto border-l border-border-100 pl-2">{sessionModels.map(model => <p key={`${model.provider}/${model.id}`} className="truncate text-text-400" title={`${model.provider}/${model.id}`}>{model.name} · {model.provider} · {model.contextWindow.toLocaleString()} context</p>)}</div></details>

      <div className="flex flex-wrap gap-2 border-y border-border-100 py-2">
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('new', async () => applyReplacement(await createNativePiSession(sessionId, sessionId)))}>New native session</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('cycle-model', async () => { const result = await cyclePiSessionModel(sessionId); applySnapshotToUi(result.snapshot); setSnapshot(result.snapshot) })}>Next model</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('cycle-thinking', async () => { const result = await cyclePiThinkingLevel(sessionId); applySnapshotToUi(result.snapshot); setSnapshot(result.snapshot) })}>Cycle thinking</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('idle', async () => { const result = await waitForPiSessionIdle(sessionId); applySnapshotToUi(result.snapshot); setSnapshot(result.snapshot) })}>Wait for idle</Button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <select className={inputClass} value={targetSessionId} onChange={event => setTargetSessionId(event.target.value)}>{sessions.filter(item => item.id !== sessionId).map(item => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}</select>
        <Button size="sm" disabled={busy !== null || !targetSessionId} onClick={() => void run('switch', async () => applyReplacement(await switchNativePiSession(sessionId, targetSessionId)))}>Switch native session</Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <input className={`${inputClass} min-w-44 flex-1`} value={userMessage} placeholder="Send user message through native Pi API" onChange={event => setUserMessage(event.target.value)} />
        <select className="h-8 rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-xs)] text-text-200" value={deliveryMode} onChange={event => setDeliveryMode(event.target.value as typeof deliveryMode)}><option value="">Next turn</option><option value="steer">Steer</option><option value="followUp">Follow-up</option></select>
        <Button size="sm" disabled={busy !== null || !userMessage.trim()} onClick={() => void run('user-message', async () => { await sendPiUserMessage(sessionId, userMessage.trim(), deliveryMode || undefined); setUserMessage('') })}>Send</Button>
      </div>

      <label className="block space-y-1"><span className="text-[length:var(--fs-xs)] text-text-400">Scoped model patterns, one per line</span><textarea rows={3} className="w-full resize-y rounded-md border border-border-200 bg-bg-100 p-2 font-mono text-[length:var(--fs-xs)] text-text-100" value={scopedModels} onChange={event => setScopedModels(event.target.value)} /></label>
      <Button size="sm" disabled={busy !== null} onClick={() => void run('scoped-models', async () => { const result = await setPiScopedModels(sessionId, scopedModels.split(/\r?\n/).map(item => item.trim()).filter(Boolean)); applySnapshotToUi(result.snapshot); setSnapshot(result.snapshot) })}>Apply model scope</Button>

      <div className="flex flex-wrap gap-2 border-t border-border-100 pt-3"><input className={`${inputClass} min-w-44 flex-1`} value={bashCommand} placeholder="One-shot bash command" onChange={event => setBashCommand(event.target.value)} /><Button size="sm" disabled={busy !== null || !bashCommand.trim()} onClick={() => void run('bash', async () => setBashResult((await executePiBash(sessionId, bashCommand.trim())).result))}>Run</Button><Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void run('abort-bash', async () => { const result = await abortPiBash(sessionId); applySnapshotToUi(result.snapshot) })}>Abort</Button></div>
      {bashResult !== undefined ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-bg-200/40 p-2 text-[length:var(--fs-xs)] text-text-300">{formatValue(bashResult)}</pre> : null}

      <div className="flex flex-wrap gap-2"><input className={`${inputClass} min-w-44 flex-1`} value={exportPath} placeholder="Optional output path" onChange={event => setExportPath(event.target.value)} /><Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('export-html', async () => setExportResult((await exportPiSession(sessionId, 'html', exportPath.trim() || undefined)).result))}>Export HTML</Button><Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('export-jsonl', async () => setExportResult((await exportPiSession(sessionId, 'jsonl', exportPath.trim() || undefined)).result))}>Export JSONL</Button></div>
      {exportResult !== undefined ? <p className="break-all text-[length:var(--fs-xs)] text-text-300">{formatValue(exportResult)}</p> : null}

      <details className="border-t border-border-100 pt-3 text-[length:var(--fs-xs)]"><summary className="cursor-pointer text-text-300">Extension host commands</summary><div className="mt-2 space-y-2"><input className={inputClass} value={customType} placeholder="Custom type" onChange={event => setCustomType(event.target.value)} /><textarea rows={3} className="w-full rounded-md border border-border-200 bg-bg-100 p-2 font-mono text-text-100" value={customPayload} onChange={event => setCustomPayload(event.target.value)} /><div className="flex gap-2"><Button size="sm" variant="secondary" disabled={busy !== null || !customType.trim()} onClick={() => void run('custom-message', async () => { const value = parseJson(); const content = typeof value === 'string' ? [{ type: 'text' as const, text: value }] : [{ type: 'text' as const, text: JSON.stringify(value) }]; const result = await sendPiCustomMessage(sessionId, { customType: customType.trim(), content, display: true }); applySnapshotToUi(result.snapshot) })}>Send custom message</Button><Button size="sm" variant="secondary" disabled={busy !== null || !customType.trim()} onClick={() => void run('custom-entry', async () => { const result = await appendPiCustomEntry(sessionId, customType.trim(), parseJson()); applySnapshotToUi(result.snapshot) })}>Append custom entry</Button></div></div></details>
    </section>
  )
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}
