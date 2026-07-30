import type { UiSession } from '../types/session'
import type { SessionInfo } from '@earendil-works/pi-coding-agent'

export function piSessionInfoToUiSession(item: SessionInfo): UiSession | null {
  if (!item.id || !item.cwd || !item.path) return null
  const name = firstString(item.name)
  const firstMessage = firstString(item.firstMessage)
  const createdAt = parseTime(item.created)
  const updatedAt = parseTime(item.modified) || createdAt
  return {
    id: item.id,
    directory: item.cwd,
    title: name || firstMessage || 'New chat',
    firstMessage,
    messageCount: typeof item.messageCount === 'number' ? item.messageCount : undefined,
    searchText: firstString(item.allMessagesText),
    isNamed: Boolean(name),
    createdAt,
    updatedAt,
    path: item.path,
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
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function pathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}
