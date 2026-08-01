import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { RegistrySnapshot } from '@piui/protocol'
import { Button } from '../../../components/ui/Button'
import { extensionUiStore } from '../../../pi/extensionUiStore'
import { useManagementEvents } from '../../../pi/managementEventStore'
import { loadPiSessionRegistry, reloadPiSessionResources } from '../../../pi/controllers/index.js'

const inputClass = 'h-8 w-full rounded-md border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100'

/**
 * Session resource inspector over the native runtime registry (registry.get).
 * Extensions, tools, commands and event handlers come straight from the
 * session's extension runner; reload goes through the native reload command.
 */
export function PiResourceManagement({ sessionId, workspacePath }: { sessionId: string | null; workspacePath: string }) {
  const [registry, setRegistry] = useState<RegistrySnapshot | null>(null)
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
      setRegistry((await loadPiSessionRegistry(sessionId)) ?? null)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    const onRegistryUpdated = (event: Event) => {
      const updatedSessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId
      if (updatedSessionId === sessionId) void load()
    }
    window.addEventListener('piui:registry-updated', onRegistryUpdated)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('piui:registry-updated', onRegistryUpdated)
    }
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

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3"><div><h3 className="text-[length:var(--fs-sm)] font-medium text-text-100">Session resources and inspection</h3><p className="text-[length:var(--fs-xs)] text-text-400">Inspect the session's native runtime registry and reload resources.</p></div><Button size="sm" variant="secondary" disabled={busy !== null} isLoading={busy === 'reload'} onClick={() => void run('reload', async () => { await reloadPiSessionResources(sessionId); await load() })}>Reload</Button></div>
      {error ? <p role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</p> : null}
      <p className="text-[length:var(--fs-xs)] text-text-400">{registry ? `${registry.extensions.length} extensions · ${registry.tools.length} tools (${registry.activeTools.length} active) · ${registry.commands.length} commands · ${registry.eventHandlers.length} event handlers` : 'Loading registry…'}</p>

      {registry ? <div className="space-y-2">
        <ResourceList title="Extensions" items={registry.extensions.map(item => ({ name: item.path, detail: `${item.tools.length} tools · ${item.commands.length} commands · ${item.handlers.length} handlers${item.hidden ? ' · hidden' : ''}` }))} />
        <ResourceList title="Tools" items={registry.tools.map(item => ({ name: `${item.name}${registry.activeTools.includes(item.name) ? '' : ' (inactive)'}`, detail: item.description ?? '' }))} />
        <ResourceList title="Commands" items={registry.commands.map(item => ({ name: item.name, detail: item.description ?? '' }))} />
        <ResourceList title="Event handlers" items={registry.eventHandlers.map(name => ({ name, detail: '' }))} />
      </div> : null}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-border-100 pt-3"><input className={inputClass} placeholder="Extension event type" value={eventType} onChange={event => setEventType(event.target.value)} /><Button size="sm" variant="secondary" disabled={busy !== null || !eventType.trim()} onClick={() => setHandlerResult(registry?.eventHandlers.includes(eventType.trim()) ?? null)}>Check handler</Button></div>
      {handlerResult !== null ? <p className="text-[length:var(--fs-xs)] text-text-300">Handler {handlerResult ? 'registered' : 'not registered'} for {eventType}</p> : null}

      {registry ? <JsonDetails title="Registry data" value={registry} /> : null}
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
