import { describe, expect, it } from 'vitest'
import { parsePtyFrame } from './ptyProtocol'

describe('parsePtyFrame', () => {
  it('returns text frames unchanged', () => {
    expect(parsePtyFrame('hello\r\n')).toEqual({ kind: 'data', data: 'hello\r\n' })
  })

  it('parses websocket binary control frames', () => {
    const payload = new TextEncoder().encode('{"cursor":73}')
    const bytes = new Uint8Array(payload.length + 1)
    bytes[0] = 0
    bytes.set(payload, 1)

    expect(parsePtyFrame(bytes.buffer)).toEqual({ kind: 'control', cursor: 73 })
  })

  it('parses tauri bridge control frames with leading null byte', () => {
    expect(parsePtyFrame('\0{"cursor":73}')).toEqual({ kind: 'control', cursor: 73 })
  })

  it('decodes binary text frames', () => {
    const bytes = new TextEncoder().encode('ls\n')
    expect(parsePtyFrame(bytes.buffer)).toEqual({ kind: 'data', data: 'ls\n' })
  })

  it('ignores malformed control frames', () => {
    expect(parsePtyFrame('\0{"cursor":"oops"}')).toBeNull()
  })
})
