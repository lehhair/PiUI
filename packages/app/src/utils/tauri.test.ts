import { describe, expect, it, afterEach } from 'vitest'
import { isTauri, isTauriMobile, extToMime } from './tauri'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 需要动态修改 window 属性做测试
const win = window as any

describe('isTauri', () => {
  afterEach(() => {
    delete win.__TAURI_INTERNALS__
  })

  it('returns false in browser environment (no __TAURI_INTERNALS__)', () => {
    expect(isTauri()).toBe(false)
  })

  it('returns true when __TAURI_INTERNALS__ is present', () => {
    win.__TAURI_INTERNALS__ = {}
    expect(isTauri()).toBe(true)
  })
})

describe('isTauriMobile', () => {
  afterEach(() => {
    delete win.__TAURI_INTERNALS__
  })

  it('returns false when not in Tauri environment', () => {
    expect(isTauriMobile()).toBe(false)
  })

  it('returns false in Tauri desktop environment', () => {
    win.__TAURI_INTERNALS__ = {}
    // jsdom 默认 userAgent 不含移动端标识
    expect(isTauriMobile()).toBe(false)
  })
})

describe('extToMime', () => {
  it('returns correct MIME for common image types', () => {
    expect(extToMime('png')).toBe('image/png')
    expect(extToMime('jpg')).toBe('image/jpeg')
    expect(extToMime('svg')).toBe('image/svg+xml')
  })

  it('returns correct MIME for audio/video types', () => {
    expect(extToMime('mp3')).toBe('audio/mpeg')
    expect(extToMime('mp4')).toBe('video/mp4')
  })

  it('returns octet-stream for unknown extensions', () => {
    expect(extToMime('xyz')).toBe('application/octet-stream')
    expect(extToMime('foo')).toBe('application/octet-stream')
  })
})
