export interface SessionStats {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  totalCost: number
  contextUsed: number
  contextLimit: number
  contextPercent: number
  contextEstimated: boolean
}
