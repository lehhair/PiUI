import { describe, expect, it } from 'vitest'
import { attachmentToImage } from './attachmentToImage'
import type { Attachment } from '../attachment'

function imageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    type: 'file',
    displayName: 'photo.png',
    url: 'data:image/png;base64,QUJDREVGRw==',
    mime: 'image/png',
    ...overrides,
  }
}

describe('attachmentToImage', () => {
  it('converts a data-url image attachment to a native Pi ImageContent block', () => {
    expect(attachmentToImage(imageAttachment())).toEqual({
      type: 'image',
      data: 'QUJDREVGRw==',
      mimeType: 'image/png',
    })
  })

  it('returns null for non-image attachments', () => {
    expect(attachmentToImage(imageAttachment({ mime: 'text/plain' }))).toBeNull()
    expect(attachmentToImage(imageAttachment({ type: 'file', url: undefined }))).toBeNull()
  })

  it('returns null for non-data-url or malformed urls', () => {
    expect(attachmentToImage(imageAttachment({ url: 'file:///tmp/photo.png' }))).toBeNull()
    expect(attachmentToImage(imageAttachment({ url: 'data:image/png;base64' }))).toBeNull()
  })
})
