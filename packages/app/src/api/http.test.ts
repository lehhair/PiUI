import { describe, expect, it } from 'vitest'
import { buildQueryString } from './http'

// ============================================
// buildQueryString 测试
// ============================================

describe('buildQueryString', () => {
  it('returns empty string for empty params', () => {
    expect(buildQueryString({})).toBe('')
  })

  it('skips undefined values', () => {
    expect(buildQueryString({ a: 'hello', b: undefined })).toBe('?a=hello')
  })

  it('handles string, number, boolean values', () => {
    const result = buildQueryString({ name: 'test', page: 1, active: true })
    expect(result).toBe('?name=test&page=1&active=true')
  })

  it('encodes special characters in values', () => {
    const result = buildQueryString({ directory: 'C:\\Program Files\\app' })
    expect(result).toBe('?directory=C%3A%5CProgram%20Files%5Capp')
  })

  it('encodes special characters in keys', () => {
    const result = buildQueryString({ 'key with spaces': 'value' })
    expect(result).toBe('?key%20with%20spaces=value')
  })

  it('encodes ampersand and equals in values', () => {
    const result = buildQueryString({ q: 'a=1&b=2' })
    expect(result).toBe('?q=a%3D1%26b%3D2')
  })

  it('encodes unicode characters', () => {
    const result = buildQueryString({ path: '/home/用户/project' })
    expect(result).toBe('?path=%2Fhome%2F%E7%94%A8%E6%88%B7%2Fproject')
  })
})
