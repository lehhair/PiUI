export type AgentMode = 'primary' | 'subagent' | 'all'
export interface AgentPermission { permission: string; pattern?: string; action: 'allow' | 'deny' | 'ask' }
export interface Agent {
  name: string
  description?: string
  mode?: AgentMode
  model?: { providerID: string; modelID: string }
  permission?: AgentPermission[]
  hidden?: boolean
  color?: string
  options?: Record<string, unknown>
}
