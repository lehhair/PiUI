import type { VcsDiffData as SDKVcsDiffData, VcsInfo as SDKVcsInfo } from '@opencode-ai/sdk/v2/client'

export type VcsInfo = SDKVcsInfo

export type VcsDiffMode = SDKVcsDiffData['query']['mode']
