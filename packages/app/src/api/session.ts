// ============================================
// Pi-native Session API Functions
// ============================================

import { UnsupportedPiCapabilityError } from './errors'
import {
  abortSessionCommand,
  createPiSession,
  deletePiSession,
  fetchSnapshot,
  listPiSessions,
  resolveWorkspacePath,
  setPiSessionName,
} from '../pi/sessionApi'
import { snapshotToUiSession, toUiSession } from '../pi/sessionModel'
import type { FileDiff } from './types'
import type { SessionListParams, SessionStatusMap, UiSession } from '../types/session'
import type { TodoItem } from '../types/api/event'
import { paneLayoutStore } from '../store/paneLayoutStore'
import { clearSessionRuntimeState } from '../utils/sessionLifecycle'

function unsupported(capability: string): never {
  throw new UnsupportedPiCapabilityError(capability)
}

export async function getSessionStatus(directory?: string): Promise<SessionStatusMap> {
  const workspacePath = directory ? await resolveWorkspacePath(directory) : null
  const sessions = await listPiSessions(workspacePath ?? undefined)
  const snapshots = await Promise.all(sessions.map(session => fetchSnapshot(session.id)))
  return Object.fromEntries(
    snapshots.map(snapshot => [
      snapshot.session.id,
      snapshot.session.state === 'idle' ? { type: 'idle' as const } : { type: 'busy' as const },
    ]),
  )
}

export async function getSessionDiff(
  _sessionId: string,
  _directory?: string,
  _messageId?: string,
): Promise<FileDiff[]> {
  return unsupported('session diff')
}

export async function getLastTurnDiff(_sessionId: string, _directory?: string): Promise<FileDiff[]> {
  return unsupported('turn diff')
}

export async function getSessions(params: SessionListParams = {}): Promise<UiSession[]> {
  const workspacePath = params.directory ? await resolveWorkspacePath(params.directory) : null
  let sessions = (await listPiSessions(workspacePath ?? undefined))
    .filter(session => !params.search || session.title.toLowerCase().includes(params.search.toLowerCase()))

  if (params.start != null) {
    sessions = sessions.filter(session => Date.parse(session.updatedAt) < params.start!)
  }
  if (params.limit != null) sessions = sessions.slice(0, Math.max(0, params.limit))
  return sessions.map(session => toUiSession(session, params.directory))
}

export async function getSession(sessionId: string, directory?: string): Promise<UiSession> {
  return snapshotToUiSession(await fetchSnapshot(sessionId), directory)
}

export async function createSession(
  params: { directory?: string; title?: string } = {},
): Promise<UiSession> {
  const workspacePath = await resolveWorkspacePath(params.directory)
  if (!workspacePath) throw new Error('No Pi workspace is available')
  const { snapshot } = await createPiSession({ workspacePath, title: params.title })
  return snapshotToUiSession(snapshot, params.directory)
}

export async function updateSession(
  sessionId: string,
  params: { title?: string; archivedAt?: number | null },
  directory?: string,
): Promise<UiSession> {
  if (params.title === undefined || params.archivedAt !== undefined) {
    return unsupported('session metadata updates')
  }
  const { snapshot } = await setPiSessionName(sessionId, params.title)
  return snapshotToUiSession(snapshot, directory)
}

export async function deleteSession(sessionId: string, _directory?: string): Promise<boolean> {
  await deletePiSession(sessionId)
  clearSessionRuntimeState(sessionId)
  paneLayoutStore.clearSession(sessionId)
  return true
}

export async function abortSession(sessionId: string, _directory?: string): Promise<boolean> {
  const result = await abortSessionCommand(sessionId)
  return result != null
}

export async function revertMessage(
  _sessionId: string,
  _messageId: string,
  _partId?: string,
  _directory?: string,
): Promise<UiSession> {
  return unsupported('message revert')
}

export async function unrevertSession(_sessionId: string, _directory?: string): Promise<UiSession> {
  return unsupported('message revert')
}

export async function shareSession(_sessionId: string, _directory?: string): Promise<string> {
  return unsupported('session sharing')
}

export async function unshareSession(_sessionId: string, _directory?: string): Promise<void> {
  return unsupported('session sharing')
}

export async function forkSession(
  _sessionId: string,
  _messageId?: string,
  _directory?: string,
): Promise<UiSession> {
  return unsupported('session forks')
}

export async function summarizeSession(
  _sessionId: string,
  _params: { providerID: string; modelID: string; auto?: boolean },
  _directory?: string,
): Promise<boolean> {
  return unsupported('legacy session summarization')
}

export async function getSessionChildren(_sessionId: string, _directory?: string): Promise<UiSession[]> {
  return unsupported('child sessions')
}

export type ApiTodo = TodoItem

export async function getSessionTodos(_sessionId: string, _directory?: string): Promise<ApiTodo[]> {
  return unsupported('session todos')
}
