import { describe, expect, it } from 'vitest'
import { formatCost, formatTokens } from './sessionStatsUtils'

describe('formatTokens', () => {
  it('formats small token counts as raw numbers', () => {
    expect(formatTokens(999)).toBe('999')
  })

  it('formats thousands with k suffix', () => {
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(15000)).toBe('15.0k')
  })

  it('formats millions with M suffix', () => {
    expect(formatTokens(1500000)).toBe('1.5M')
  })
})

describe('formatCost', () => {
  it('formats zero cost', () => {
    expect(formatCost(0)).toBe('$0')
  })

  it('formats very small cost with threshold marker', () => {
    expect(formatCost(0.0004)).toBe('<$0.001')
  })

  it('formats sub-cent and regular costs', () => {
    expect(formatCost(0.009)).toBe('$0.009')
    expect(formatCost(0.5)).toBe('$0.50')
    expect(formatCost(2.345)).toBe('$2.35')
  })
})
