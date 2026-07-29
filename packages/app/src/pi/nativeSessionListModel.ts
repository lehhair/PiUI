import type { UiSession } from '../types/session'
import type { PiSessionListItem } from './nativeApi'

export function piSessionInfoToUiSession(item: PiSessionListItem): UiSession | null {
  const id = firstString(item.id, item.sessionId)
  const directory = firstString(item.cwd, item.workspacePath)
  if (!id || !directory) return null
  const name = firstString(item.name, item.title)
  const firstMessage = firstString(item.firstMessage)
  const createdAt = parseTime(item.createdAt ?? item.created)
  const updatedAt = parseTime(item.updatedAt ?? item.modified) || createdAt
  return {
    id,
    directory,
    title: name || firstMessage || 'New chat',
    firstMessage,
    messageCount: typeof item.messageCount === 'number' ? item.messageCount : undefined,
    searchText: firstString(item.allMessagesText),
    isNamed: Boolean(name),
    createdAt,
    updatedAt,
    path: firstString(item.sessionFile, item.path),
    parentSessionPath: typeof item.parentSessionPath === 'string' ? item.parentSessionPath : undefined,
  }
}

export function filterPiSessionList(sessions: UiSession[], search: string): UiSession[] {
  const query = search.trim().toLowerCase()
  if (!query) return sessions
  return sessions.filter(session =>
    session.title.toLowerCase().includes(query) ||
    session.directory.toLowerCase().includes(query) ||
    session.id.toLowerCase().includes(query) ||
    session.searchText?.toLowerCase().includes(query),
  )
}

export function linkPiSessionForks(sessions: UiSession[]): UiSession[] {
  const sessionByPath = new Map<string, UiSession>()
  for (const session of sessions) {
    if (session.path) sessionByPath.set(pathKey(session.path), session)
  }
  return sessions.map(session => {
    if (!session.parentSessionPath) return session
    const parent = sessionByPath.get(pathKey(session.parentSessionPath))
    if (!parent || parent.id === session.id) return session
    return {
      ...session,
      forkParentId: parent.id,
      forkParentTitle: parent.title,
    }
  })
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function pathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}
