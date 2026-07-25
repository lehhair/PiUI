// ============================================
// Message API Functions
// ============================================

import type { Attachment, RevertedMessage } from './types'
import type { AgentPart, FilePart, Message, TextPart } from '../types/message'

type UserContentSource = Pick<Message, 'parts'>

function isTextUserContentPart(part: UserContentSource['parts'][number]): part is TextPart {
  return part.type === 'text' && 'text' in part
}

function isFileUserContentPart(part: UserContentSource['parts'][number]): part is FilePart {
  return part.type === 'file' && 'mime' in part && 'url' in part
}

function isAgentUserContentPart(part: UserContentSource['parts'][number]): part is AgentPart {
  return part.type === 'agent' && 'name' in part
}

export function extractUserMessageContent(message: UserContentSource): RevertedMessage {
  const text = message.parts
    .filter((part): part is TextPart => isTextUserContentPart(part) && !part.synthetic)
    .map(part => part.text)
    .join('\n')
  const attachments: Attachment[] = []

  for (const part of message.parts) {
    if (isFileUserContentPart(part)) {
      const sourcePath = part.source && 'path' in part.source ? part.source.path : undefined
      attachments.push({
        id: part.id || crypto.randomUUID(),
        type: part.mime === 'application/x-directory' ? 'folder' : 'file',
        displayName: part.filename || sourcePath || 'file',
        url: part.url,
        mime: part.mime,
        relativePath: sourcePath,
        textRange: part.source?.text
          ? { value: part.source.text.value, start: part.source.text.start, end: part.source.text.end }
          : undefined,
      })
    } else if (isAgentUserContentPart(part)) {
      attachments.push({
        id: part.id || crypto.randomUUID(),
        type: 'agent',
        displayName: part.name,
        agentName: part.name,
        textRange: part.source
          ? { value: part.source.value, start: part.source.start, end: part.source.end }
          : undefined,
      })
    }
  }

  return { text, attachments }
}
