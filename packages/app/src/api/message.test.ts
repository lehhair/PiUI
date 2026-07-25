import { describe, expect, it } from 'vitest'
import { extractUserMessageContent } from './message'
import type { Message } from '../types/message'

describe('message content extraction', () => {
  it('extracts visible text and Pi-compatible attachment metadata', () => {
    const message = {
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'hidden', synthetic: true },
        {
          id: 'file-1',
          type: 'file',
          mime: 'text/plain',
          filename: 'demo.txt',
          url: 'file:///demo.txt',
          source: { type: 'file', path: 'demo.txt', text: { value: 'demo', start: 0, end: 4 } },
        },
        { id: 'agent-1', type: 'agent', name: 'review' },
      ],
    } as unknown as Pick<Message, 'parts'>

    expect(extractUserMessageContent(message)).toEqual({
      text: 'hello',
      attachments: [
        expect.objectContaining({ id: 'file-1', type: 'file', displayName: 'demo.txt', relativePath: 'demo.txt' }),
        expect.objectContaining({ id: 'agent-1', type: 'agent', displayName: 'review' }),
      ],
    })
  })
})
