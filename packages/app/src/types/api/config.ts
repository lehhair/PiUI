export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ServerConfig {
  hostname?: string
  port?: number
}

export type PermissionActionConfig = 'allow' | 'deny' | 'ask'
export type PermissionObjectConfig = PermissionActionConfig | Record<string, PermissionActionConfig>
export interface PermissionRuleConfig {
  pattern: string
  action: PermissionActionConfig
}
export type PermissionConfig = Record<string, PermissionObjectConfig | PermissionRuleConfig[]>

export interface AgentConfig {
  description?: string
  model?: string
  prompt?: string
  tools?: Record<string, boolean>
}

export interface ProviderConfig {
  options?: Record<string, unknown>
  models?: Record<string, Record<string, unknown>>
}

export interface McpLocalConfig {
  type: 'local'
  command: string[]
  env?: Record<string, string>
}

export interface McpOAuthConfig {
  clientId?: string
  scopes?: string[]
}

export interface McpRemoteConfig {
  type: 'remote'
  url: string
  headers?: Record<string, string>
  oauth?: McpOAuthConfig
}

export interface LayoutConfig {
  sidebar?: { width?: number }
  bottomPanel?: { height?: number }
}

export interface Config {
  server?: ServerConfig
  logLevel?: LogLevel
  permission?: PermissionConfig
  agent?: Record<string, AgentConfig>
  provider?: Record<string, ProviderConfig>
  mcp?: Record<string, McpLocalConfig | McpRemoteConfig>
  layout?: LayoutConfig
}
