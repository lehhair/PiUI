// ============================================
// Command API - 命令列表和执行
// ============================================

import i18n from '../i18n'
import { isPiServerUp, listSessionCommands } from '../pi/sessionApi'
import { sessionProjectionStore } from '../pi/sessionProjectionStore'

export interface Command {
  name: string
  description?: string
  keybind?: string
  source: 'frontend' | 'api'
}

// Frontend-added slash commands that do not come from GET /command.
// These are executed locally or via dedicated session actions.
function getFrontendCommands(): Command[] {
  return [
    { name: 'new', description: i18n.t('commands:slashCommand.newSessionDesc'), source: 'frontend' },
    { name: 'compact', description: i18n.t('commands:slashCommand.compactDesc'), source: 'frontend' },
  ]
}

const COMMAND_CACHE_TTL_MS = 10_000

const commandCache = new Map<string, { data: Command[]; expiresAt: number }>()
const commandInflight = new Map<string, Promise<Command[]>>()

function getCommandCacheKey(directory?: string): string {
  return `${sessionProjectionStore.getActiveSessionId() ?? 'none'}::${i18n.resolvedLanguage || i18n.language}::${directory ?? ''}`
}

async function fetchCommands(_directory?: string): Promise<Command[]> {
  // Pi session commands first
  try {
    if (await isPiServerUp()) {
      const sid = sessionProjectionStore.getActiveSessionId()
      if (sid) {
        const { commands } = await listSessionCommands(sid)
        const fromPi: Command[] = commands.map(c => ({
          name: c.name.replace(/^\/+/, ''),
          description: c.description,
          source: 'api' as const,
        }))
        const frontendCommands = getFrontendCommands()
        const names = new Set(fromPi.map(c => c.name))
        return [...fromPi, ...frontendCommands.filter(c => !names.has(c.name))]
      }
    }
  } catch {
    /* fall through */
  }

  return getFrontendCommands()
}

export async function getCommands(directory?: string): Promise<Command[]> {
  const key = getCommandCacheKey(directory)
  const now = Date.now()
  const cached = commandCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.data
  }

  const inflight = commandInflight.get(key)
  if (inflight) {
    return inflight
  }

  const request = fetchCommands(directory)
    .then(data => {
      commandCache.set(key, { data, expiresAt: Date.now() + COMMAND_CACHE_TTL_MS })
      return data
    })
    .finally(() => {
      commandInflight.delete(key)
    })

  commandInflight.set(key, request)
  return request
}

export async function prefetchCommands(directory?: string): Promise<void> {
  await getCommands(directory)
}
