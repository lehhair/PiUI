import type { ApiAgent } from './types'

export async function getAgents(_directory?: string): Promise<ApiAgent[]> {
  return []
}

export async function getSelectableAgents(directory?: string): Promise<ApiAgent[]> {
  return (await getAgents(directory)).filter(agent => !agent.hidden)
}
