import { useSyncExternalStore } from 'react'
import { useMemo } from 'react'
import { piSessionInfoStore, piBranchStore, piSessionStateStore, piModelsStore } from '../state/index.js'
import { paneLayoutStore } from '../../store/paneLayoutStore'

/**
 * React bindings for Pi stores.
 * Session-scoped hooks take sessionId (null yields empty snapshots),
 * keeping multi-pane renders isolated per session.
 */

/** Focused pane's session id (the app-wide "current session"). */
export function useFocusedSessionId(): string | null {
  return useSyncExternalStore(
    paneLayoutStore.subscribe,
    () => paneLayoutStore.getFocusedSessionId(),
    () => paneLayoutStore.getFocusedSessionId(),
  )
}

/** Whether the focused session has any timeline entries. */
export function useFocusedSessionHasEntries(): boolean {
  const sessionId = useFocusedSessionId()
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => (sessionId ? (piBranchStore.getData(sessionId)?.items.length ?? 0) > 0 : false),
    () => false,
  )
}

export type PiTodoItem = {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

function extractTodosFromExecution(callArguments: unknown, resultDetails: unknown): PiTodoItem[] {
  const input = callArguments && typeof callArguments === 'object' ? (callArguments as Record<string, unknown>) : undefined
  const details = resultDetails && typeof resultDetails === 'object' && !Array.isArray(resultDetails)
    ? (resultDetails as Record<string, unknown>)
    : undefined
  return (details?.todos as PiTodoItem[]) || (input?.todos as PiTodoItem[]) || []
}

/**
 * Latest todoWrite todos in the branch (native: the todo list lives in the
 * most recent todo tool call/result, not in a side store).
 */
export function usePiSessionTodos(sessionId: string | null): PiTodoItem[] {
  const branch = usePiBranchData(sessionId)
  return useMemo(() => {
    const items = branch?.items ?? []
    let latest: PiTodoItem[] = []
    for (const entry of items) {
      if (entry.type !== 'message') continue
      const message = entry.message
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'toolCall' && block.name.toLowerCase().includes('todo')) {
            const todos = extractTodosFromExecution(block.arguments, undefined)
            if (todos.length > 0) latest = todos
          }
        }
      } else if (message.role === 'toolResult' && message.toolName.toLowerCase().includes('todo')) {
        const todos = extractTodosFromExecution(undefined, message.details)
        if (todos.length > 0) latest = todos
      }
    }
    return latest
  }, [branch])
}

export function usePiSessionInfos() {
  return useSyncExternalStore(
    piSessionInfoStore.subscribe,
    () => piSessionInfoStore.getAll(),
    () => piSessionInfoStore.getAll(),
  )
}

export function usePiBranchData(sessionId: string | null) {
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => (sessionId ? piBranchStore.getData(sessionId) : null),
    () => (sessionId ? piBranchStore.getData(sessionId) : null),
  )
}

export function usePiBranchLoading(sessionId: string | null) {
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => (sessionId ? piBranchStore.isLoading(sessionId) : false),
    () => (sessionId ? piBranchStore.isLoading(sessionId) : false),
  )
}

export function usePiBranchError(sessionId: string | null) {
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => (sessionId ? piBranchStore.getError(sessionId) : null),
    () => (sessionId ? piBranchStore.getError(sessionId) : null),
  )
}

export function usePiSessionRuntimeState(sessionId: string | null) {
  return useSyncExternalStore(
    piSessionStateStore.subscribe,
    () => (sessionId ? piSessionStateStore.getState(sessionId) : null),
    () => (sessionId ? piSessionStateStore.getState(sessionId) : null),
  )
}

export function usePiModels() {
  const models = useSyncExternalStore(
    piModelsStore.subscribe,
    () => piModelsStore.getModels(),
    () => piModelsStore.getModels(),
  )
  const isLoading = useSyncExternalStore(
    piModelsStore.subscribe,
    () => piModelsStore.isLoading(),
    () => piModelsStore.isLoading(),
  )
  return { models, isLoading }
}

/**
 * Session display title, same chain as the session list:
 * runtime sessionName -> SessionInfo.name -> firstMessage.
 */
export function usePiSessionTitle(sessionId: string | null): string | null {
  const state = usePiSessionRuntimeState(sessionId)
  const sessionInfos = usePiSessionInfos()
  return useMemo(() => {
    if (!sessionId) return null
    const stateName = typeof state?.sessionName === 'string' && state.sessionName.trim() ? state.sessionName.trim() : null
    if (stateName) return stateName
    const info = sessionInfos.find(item => item.id === sessionId)
    return info?.name?.trim() || info?.firstMessage?.trim() || null
  }, [sessionId, state?.sessionName, sessionInfos])
}
