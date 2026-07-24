// ============================================
// Command API - 命令列表和执行
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'
import { serverStore } from '../store/serverStore'
import i18n from '../i18n'

export interface Command {
  name: string
  description?: string
  keybind?: string
  source: 'frontend' | 'api'
}

type ApiCommand = Omit<Command, 'source'>

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
  return `${serverStore.getActiveServerId()}::${i18n.resolvedLanguage || i18n.language}::${formatPathForApi(directory) ?? ''}`
}

async function fetchCommands(directory?: string): Promise<Command[]> {
  let apiCommands: ApiCommand[] = []
  try {
    const sdk = getSDKClient()
    apiCommands = unwrap(await sdk.command.list({ directory: formatPathForApi(directory) })) ?? []
  } catch {
    // Backend unreachable — frontend commands still available
  }
  const frontendCommands = getFrontendCommands()
  const commandsFromApi: Command[] = apiCommands.map(command => ({ ...command, source: 'api' }))
  const apiNames = new Set(commandsFromApi.map(c => c.name))
  return [...commandsFromApi, ...frontendCommands.filter(c => !apiNames.has(c.name))]
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

export async function executeCommand(
  sessionId: string,
  command: string,
  args: string = '',
  directory?: string,
): Promise<unknown> {
  const sdk = getSDKClient()
  return unwrap(
    await sdk.session.command({
      sessionID: sessionId,
      directory: formatPathForApi(directory),
      command,
      arguments: args,
    }),
  )
}
