import { describe, expect, it } from 'vitest'
import {
  detectMentionTrigger,
  extractMentions,
  formatMentionLabel,
  getFileName,
  normalizePath,
  parseMentions,
  serializeMention,
  stripMentions,
  toAbsolutePath,
  toFileUrl,
} from './utils'

describe('mention utils', () => {
  it('normalizes paths and extracts file names', () => {
    expect(normalizePath('foo\\bar//baz.ts')).toBe('foo/bar/baz.ts')
    expect(getFileName('foo/bar/baz.ts')).toBe('baz.ts')
  })

  it('converts relative paths and file urls correctly', () => {
    expect(toAbsolutePath('./src/app.ts', '/workspace/project')).toBe('/workspace/project/./src/app.ts')
    expect(toAbsolutePath('', '/workspace/project')).toBe('/workspace/project')
    expect(toFileUrl('/workspace/project/src/app.ts')).toBe('file:///workspace/project/src/app.ts')
    expect(toFileUrl('C:/repo/app.ts')).toBe('file:///C:/repo/app.ts')
  })

  it('serializes and parses mentions', () => {
    const serialized = serializeMention({ type: 'file', value: 'src/app.ts', displayName: 'app.ts' })
    expect(serialized).toBe('[[file:src/app.ts]]')
    expect(formatMentionLabel('agent', 'planner')).toBe('@Agent: planner')

    const parsed = parseMentions('Open [[file:src/app.ts]] now')
    expect(parsed).toHaveLength(3)
    expect(parsed[1]).toMatchObject({ type: 'mention', mentionType: 'file', mentionValue: 'src/app.ts' })
  })

  it('extracts mentions and strips markup', () => {
    expect(extractMentions('[[folder:src/components]] [[file:src/app.ts]]')).toEqual([
      { type: 'folder', value: 'src/components', displayName: 'components' },
      { type: 'file', value: 'src/app.ts', displayName: 'app.ts' },
    ])
    expect(stripMentions('Look [[file:src/app.ts]] here')).toBe('Look  here'.trim())
  })

  it('detects mention trigger only in valid positions', () => {
    expect(detectMentionTrigger('hello @src/com', 14)).toEqual({ startIndex: 6, query: 'src/com' })
    expect(detectMentionTrigger('email@test.com', 14)).toBeNull()
    expect(detectMentionTrigger('hello @src com', 14)).toBeNull()
  })
})
