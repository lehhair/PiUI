// ============================================
// Message API Functions
// ============================================

import { UnsupportedPiCapabilityError } from './sdk'
import { applySnapshotToUi } from '../pi/applySnapshot'
import { fetchSnapshot, promptSession } from '../pi/sessionApi'
import { snapshotToApiMessages } from '../pi/timelineToMessages'
import type {
  ApiAgentPart,
  ApiFilePart,
  ApiMessageWithParts,
  ApiTextPart,
  Attachment,
  RevertedMessage,
  SendMessageParams,
  SendMessageResponse,
} from './types'

type UserContentSource = {
  parts: Array<ApiTextPart | ApiFilePart | ApiAgentPart | { type: string }>
}

function isTextUserContentPart(part: UserContentSource['parts'][number]): part is ApiTextPart {
  return part.type === 'text' && 'text' in part
}

function isFileUserContentPart(part: UserContentSource['parts'][number]): part is ApiFilePart {
  return part.type === 'file' && 'mime' in part && 'url' in part
}

function isAgentUserContentPart(part: UserContentSource['parts'][number]): part is ApiAgentPart {
  return part.type === 'agent' && 'name' in part
}

export async function getSessionMessages(
  sessionId: string,
  limit?: number,
  _directory?: string,
): Promise<ApiMessageWithParts[]> {
  const messages = snapshotToApiMessages(await fetchSnapshot(sessionId))
  return limit == null ? messages : messages.slice(-Math.max(0, limit))
}

export async function getSessionMessageCount(sessionId: string): Promise<number> {
  return (await getSessionMessages(sessionId)).length
}

export function extractUserMessageContent(message: UserContentSource): RevertedMessage {
  const text = message.parts
    .filter((part): part is ApiTextPart => isTextUserContentPart(part) && !part.synthetic)
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

function assertSupportedPrompt(params: SendMessageParams): void {
  if (params.attachments.length > 0) throw new UnsupportedPiCapabilityError('message attachments')
  if (params.agent) throw new UnsupportedPiCapabilityError('agent selection')
  if (params.variant) throw new UnsupportedPiCapabilityError('model variants')
}

export async function sendMessage(params: SendMessageParams): Promise<SendMessageResponse> {
  assertSupportedPrompt(params)
  const snapshot = await promptSession(params.sessionId, params.text, {
    model: params.model,
  })
  applySnapshotToUi(snapshot)
  const response = snapshotToApiMessages(snapshot).findLast(message => message.info.role === 'assistant')
  if (!response || response.info.role !== 'assistant') throw new Error('Pi session returned no assistant message')
  return { info: response.info, parts: response.parts }
}

export async function sendMessageAsync(params: SendMessageParams): Promise<void> {
  assertSupportedPrompt(params)
  const snapshot = await promptSession(params.sessionId, params.text, {
    stream: true,
    model: params.model,
  })
  applySnapshotToUi(snapshot)
}
