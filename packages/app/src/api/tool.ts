import type { ToolIDs, ToolList } from '../types/api/tool'

export async function getToolIds(_directory?: string): Promise<ToolIDs> {
  return []
}

export async function getTools(_provider: string, _model: string, _directory?: string): Promise<ToolList> {
  return []
}
