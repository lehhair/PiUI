import { UnsupportedPiCapabilityError } from './errors'
import type { MCPResourceMap, MCPStatusResponse, McpServerConfig } from '../types/api/mcp'

export async function getMcpStatus(_directory?: string): Promise<MCPStatusResponse> {
  return {}
}

export async function getMcpResources(_directory?: string): Promise<MCPResourceMap> {
  return {}
}

function unsupported(): never {
  throw new UnsupportedPiCapabilityError('MCP management')
}

export async function addMcpServer(_name: string, _config: McpServerConfig, _directory?: string): Promise<void> {
  unsupported()
}

export async function connectMcpServer(_name: string, _directory?: string): Promise<void> {
  unsupported()
}

export async function disconnectMcpServer(_name: string, _directory?: string): Promise<void> {
  unsupported()
}

export async function startMcpAuth(_name: string, _directory?: string): Promise<{ url: string }> {
  return unsupported()
}

export async function removeMcpAuth(_name: string, _directory?: string): Promise<void> {
  unsupported()
}

export async function completeMcpAuth(_name: string, _code: string, _directory?: string): Promise<void> {
  unsupported()
}

export async function authenticateMcp(_name: string, _directory?: string): Promise<void> {
  unsupported()
}
