import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { PiResourceSnapshotV1, PiRuntimeInspectionV1 } from '@piui/protocol'
import { Button } from '../../../components/ui/Button'
import { invalidateCommandCache } from '../../../api/command'
import { extensionUiStore } from '../../../pi/extensionUiStore'
import { useManagementEvents } from '../../../pi/managementEventStore'
import {
  extendPiResources,
  hasPiExtensionHandlers,
  inspectPiResources,
  inspectPiRuntime,
  inspectPiSystemPrompt,
  inspectPiToolDefinition,
  reloadPiResources,
  waitForPiCommand,
} from '../../../pi/sessionApi'

const inputClass = 'h-8 w-full rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100'

export function PiResourceManagement({ sessionId, workspacePath }: { sessionId: string | null; workspacePath: string }) {
  const [resources, setResources] = useState<PiResourceSnapshotV1 | null>(null)
  const [runtime, setRuntime] = useState<PiRuntimeInspectionV1 | null>(null)
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null)
  const [resourceKind, setResourceKind] = useState<'skillPaths' | 'promptPaths' | 'themePaths'>('skillPaths')
  const [resourcePath, setResourcePath] = useState('')
  const [toolName, setToolName] = useState('')
  const [toolDefinition, setToolDefinition] = useState<unknown>()
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
      setResources(await inspectPiResources(sessionId))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
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

  if (!sessionId) return <section><h3 className="text-[length:var(--fs-sm)] font-medium text-text-100">Session resources and inspection</h3><p className="mt-1 text-[length:var(--fs-xs)] text-text-400">Open a session to inspect its active runtime.</p></section>

  const addResourcePath = async () => {
    const path = resourcePath.trim()
    if (!path) return
    const metadata = { source: path, scope: 'temporary' as const, origin: 'top-level' as const }
    const next = await extendPiResources(sessionId, { [resourceKind]: [{ path, metadata }] })
    setResources(next)
    setResourcePath('')
  }

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3"><div><h3 className="text-[length:var(--fs-sm)] font-medium text-text-100">Session resources and inspection</h3><p className="text-[length:var(--fs-xs)] text-text-400">Inspect loaded resources, extend temporary paths and query native Pi runtime details.</p></div><Button size="sm" variant="secondary" disabled={busy !== null} isLoading={busy === 'reload'} onClick={() => void run('reload', async () => { const commandId = await reloadPiResources(sessionId); await waitForPiCommand(commandId); invalidateCommandCache(); await load() })}>Reload</Button></div>
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      <p className="text-[length:var(--fs-xs)] text-text-400">{resources ? `${resources.extensions.length} extensions · ${resources.skills.length} skills · ${resources.prompts.length} prompts · ${resources.themes.length} themes · ${resources.agentsFiles.length} AGENTS files` : 'Loading resources…'}</p>

      <div className="flex flex-wrap gap-2">
        <select className="h-8 rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-xs)] text-text-200" value={resourceKind} onChange={event => setResourceKind(event.target.value as typeof resourceKind)}><option value="skillPaths">Skill path</option><option value="promptPaths">Prompt path</option><option value="themePaths">Theme path</option></select>
        <input className={`${inputClass} min-w-44 flex-1`} value={resourcePath} placeholder="Absolute or workspace resource path" onChange={event => setResourcePath(event.target.value)} />
        <Button size="sm" disabled={busy !== null || !resourcePath.trim()} onClick={() => void run('extend', addResourcePath)}>Add temporarily</Button>
      </div>

      {resources ? <div className="space-y-2">
        <ResourceList title="Extensions" items={resources.extensions.map(item => ({ name: item.path, detail: item.resolvedPath }))} />
        <ResourceList title="Skills" items={resources.skills.map(item => ({ name: item.name, detail: `${item.description} · ${item.filePath}` }))} />
        <ResourceList title="Prompts" items={resources.prompts.map(item => ({ name: item.name, detail: `${item.description} · ${item.filePath}` }))} />
        <ResourceList title="Themes" items={resources.themes.map(item => ({ name: item.name ?? '(unnamed)', detail: item.sourcePath ?? '' }))} />
        <ResourceList title="AGENTS files" items={resources.agentsFiles.map(item => ({ name: item.path, detail: item.content }))} />
        {[...resources.diagnostics, ...resources.runtimeDiagnostics].map((item, index) => <p key={`${item.type}:${index}`} className={`text-[length:var(--fs-xs)] ${item.type === 'error' ? 'text-danger-100' : 'text-warning-100'}`}>{item.message}</p>)}
        {resources.modelFallbackMessage ? <p className="text-[length:var(--fs-xs)] text-warning-100">{resources.modelFallbackMessage}</p> : null}
      </div> : null}

      <div className="flex flex-wrap gap-2 border-t border-border-100 pt-3">
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('runtime', async () => setRuntime(await inspectPiRuntime(sessionId)))}>Runtime inspection</Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run('prompt', async () => setSystemPrompt(await inspectPiSystemPrompt(sessionId)))}>System prompt</Button>
      </div>
      {runtime ? <JsonDetails title="Runtime data" value={runtime} /> : null}
      {systemPrompt !== null ? <details open><summary className="cursor-pointer text-[length:var(--fs-xs)] text-text-300">System prompt</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-bg-200/40 p-2 text-[length:var(--fs-xs)] text-text-400">{systemPrompt}</pre></details> : null}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-border-100 pt-3"><input className={inputClass} placeholder="Tool name" value={toolName} onChange={event => setToolName(event.target.value)} /><Button size="sm" variant="secondary" disabled={busy !== null || !toolName.trim()} onClick={() => void run('tool', async () => setToolDefinition(await inspectPiToolDefinition(sessionId, toolName.trim())))}>Inspect tool</Button></div>
      {toolDefinition !== undefined ? <JsonDetails title={`Tool: ${toolName}`} value={toolDefinition} /> : null}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"><input className={inputClass} placeholder="Extension event type" value={eventType} onChange={event => setEventType(event.target.value)} /><Button size="sm" variant="secondary" disabled={busy !== null || !eventType.trim()} onClick={() => void run('handler', async () => setHandlerResult(await hasPiExtensionHandlers(sessionId, eventType.trim())))}>Check handler</Button></div>
      {handlerResult !== null ? <p className="text-[length:var(--fs-xs)] text-text-300">Handler {handlerResult ? 'registered' : 'not registered'} for {eventType}</p> : null}

      {extensionUi.sessions[sessionId] ? <JsonDetails title="Extension UI state" value={extensionUi.sessions[sessionId]} /> : null}
    </section>
  )
}

function ResourceList({ title, items }: { title: string; items: Array<{ name: string; detail: string }> }) {
  return <details className="text-[length:var(--fs-xs)]"><summary className="cursor-pointer text-text-300">{title} ({items.length})</summary><div className="mt-1 max-h-48 space-y-1 overflow-auto border-l border-border-100 pl-2">{items.map((item, index) => <div key={`${item.name}:${index}`}><p className="break-all text-text-200">{item.name}</p>{item.detail ? <p className="line-clamp-3 whitespace-pre-wrap break-all text-text-500">{item.detail}</p> : null}</div>)}</div></details>
}

function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return <details open className="text-[length:var(--fs-xs)]"><summary className="cursor-pointer text-text-300">{title}</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-200/40 p-2 text-text-400">{JSON.stringify(value, null, 2)}</pre></details>
}
