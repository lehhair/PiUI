import type { Agent as SDKAgent } from '@opencode-ai/sdk/v2/client'

export type AgentMode = SDKAgent['mode']

export type AgentPermission = SDKAgent['permission'][number]

export type Agent = SDKAgent
