import { describe, expect, it } from 'vitest'
import { serializeSessionAttachments } from './sessionApi'

describe('serializeSessionAttachments', () => {
  it('serializes uploaded images and workspace references', () => {
    expect(serializeSessionAttachments([
      {
        id: 'image',
        type: 'file',
        displayName: 'screen.png',
        mime: 'image/png',
        url: 'data:image/png;base64,iVBORw0KGgo=',
      },
      { id: 'file', type: 'file', displayName: 'app.ts', relativePath: 'src/app.ts' },
      { id: 'folder', type: 'folder', displayName: 'src', relativePath: 'src' },
    ])).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'screen.png' },
      { type: 'file', path: 'src/app.ts' },
      { type: 'directory', path: 'src' },
    ])
  })

  it('keeps textual context and ignores OpenCode agent metadata', () => {
    expect(serializeSessionAttachments([
      { id: 'text', type: 'text', displayName: 'notes', content: 'hello' },
      { id: 'agent', type: 'agent', displayName: 'build', agentName: 'build' },
    ])).toEqual([{ type: 'text', text: 'hello', name: 'notes' }])
  })

  it('rejects image attachments without data', () => {
    expect(() => serializeSessionAttachments([
      { id: 'image', type: 'file', displayName: 'screen.png', mime: 'image/png' },
    ])).toThrow('Image data missing')
  })
})
