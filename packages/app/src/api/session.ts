// ============================================
// Pi-native Session API Functions
// ============================================

import { UnsupportedPiCapabilityError } from './sdk'
import { applySnapshotToUi } from '../pi/applySnapshot'
import {
  abortSessionCommand,
  createPiSession,
  deletePiSession,
  fetchSnapshot,
  listPiSessions,
  resolveWorkspaceId,
} from '../pi/sessionApi'
import { snapshotToApiSession, toApiSession } from '../pi/toApiSession'
import type { ApiSession, SessionListParams, FileDiff } from './types'
import type { SessionStatusMap } from '../types/api/session'
import type { TodoItem } from '../types/api/event'

function unsupported(capability: string): never {
  throw new UnsupportedPiCapabilityError(capability)
}

export async function getSessionStatus(directory?: string): Promise<SessionStatusMap> {
  const workspaceId = directory ? await resolveWorkspaceId(directory) : null
  const sessions = (await listPiSessions()).filter(session => !workspaceId || session.workspaceId === workspaceId)
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

export async function getSessions(params: SessionListParams = {}): Promise<ApiSession[]> {
  const workspaceId = params.directory ? await resolveWorkspaceId(params.directory) : null
  let sessions = (await listPiSessions())
    .filter(session => !workspaceId || session.workspaceId === workspaceId)
    .filter(session => !params.search || session.title.toLowerCase().includes(params.search.toLowerCase()))

  if (params.start != null) {
    sessions = sessions.filter(session => Date.parse(session.updatedAt) < params.start!)
  }
  if (params.limit != null) sessions = sessions.slice(0, Math.max(0, params.limit))
  return sessions.map(session => toApiSession(session, params.directory))
}

export async function getSession(sessionId: string, directory?: string): Promise<ApiSession> {
  return snapshotToApiSession(await fetchSnapshot(sessionId), directory)
}

export async function createSession(
  params: { directory?: string; title?: string; parentID?: string } = {},
): Promise<ApiSession> {
  if (params.parentID) return unsupported('child sessions')
  const workspaceId = await resolveWorkspaceId(params.directory)
  if (!workspaceId) throw new Error('No Pi workspace is available')
  const { snapshot } = await createPiSession({ workspaceId, title: params.title })
  applySnapshotToUi(snapshot)
  return snapshotToApiSession(snapshot, params.directory)
}

export async function updateSession(
  _sessionId: string,
  _params: { title?: string; time?: { archived?: number } },
  _directory?: string,
): Promise<ApiSession> {
  return unsupported('session metadata updates')
}

export async function deleteSession(sessionId: string, _directory?: string): Promise<boolean> {
  await deletePiSession(sessionId)
  return true
}

export async function abortSession(sessionId: string, _directory?: string): Promise<boolean> {
  const snapshot = await abortSessionCommand(sessionId)
  if (snapshot) applySnapshotToUi(snapshot)
  return snapshot != null
}

export async function revertMessage(
  _sessionId: string,
  _messageId: string,
  _partId?: string,
  _directory?: string,
): Promise<ApiSession> {
  return unsupported('message revert')
}

export async function unrevertSession(_sessionId: string, _directory?: string): Promise<ApiSession> {
  return unsupported('message revert')
}

export async function shareSession(_sessionId: string, _directory?: string): Promise<ApiSession> {
  return unsupported('session sharing')
}

export async function unshareSession(_sessionId: string, _directory?: string): Promise<ApiSession> {
  return unsupported('session sharing')
}

export async function forkSession(
  _sessionId: string,
  _messageId?: string,
  _directory?: string,
): Promise<ApiSession> {
  return unsupported('session forks')
}

export async function summarizeSession(
  _sessionId: string,
  _params: { providerID: string; modelID: string; auto?: boolean },
  _directory?: string,
): Promise<boolean> {
  return unsupported('legacy session summarization')
}

export async function getSessionChildren(_sessionId: string, _directory?: string): Promise<ApiSession[]> {
  return unsupported('child sessions')
}

export type ApiTodo = TodoItem

export async function getSessionTodos(_sessionId: string, _directory?: string): Promise<ApiTodo[]> {
  return unsupported('session todos')
}
