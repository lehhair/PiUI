import type { McpLocalConfig, McpOAuthConfig, McpRemoteConfig } from './config'

export interface MCPStatusConnected { status: 'connected'; tools?: number }
export interface MCPStatusDisabled { status: 'disabled' }
export interface MCPStatusFailed { status: 'failed'; error: string }
export interface MCPStatusNeedsAuth { status: 'needs_auth'; url?: string }
export interface MCPStatusNeedsClientRegistration { status: 'needs_client_registration'; url?: string; error?: string }
export type MCPStatus = MCPStatusConnected | MCPStatusDisabled | MCPStatusFailed | MCPStatusNeedsAuth | MCPStatusNeedsClientRegistration
export interface MCPResource { uri: string; name: string; client: string; description?: string; mimeType?: string }
export type MCPResourceMap = Record<string, MCPResource>
export type MCPStatusResponse = Record<string, MCPStatus>
export type { McpLocalConfig, McpOAuthConfig, McpRemoteConfig }
export type McpServerConfig = McpLocalConfig | McpRemoteConfig
