// ============================================
// Message API Functions
// 基于 @opencode-ai/sdk: /session/{sessionID}/message 相关接口
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'
import type {
  ApiMessageWithParts,
  AgentPartInput,
  ApiAgentPart,
  ApiTextPart,
  ApiFilePart,
  Attachment,
  FilePartInput,
  RevertedMessage,
  SendMessageParams,
  SendMessageResponse,
  TextPartInput,
} from './types'

type PromptParams = Parameters<ReturnType<typeof getSDKClient>['session']['prompt']>[0]
type UserContentSource = {
  parts: Array<
    | ApiTextPart
    | ApiFilePart
    | ApiAgentPart
    | {
        type: string
      }
  >
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

// ============================================
// Message Query
// ============================================

/**
 * 获取 session 的消息列表
 */
export async function getSessionMessages(
  sessionId: string,
  limit?: number,
  directory?: string,
): Promise<ApiMessageWithParts[]> {
  const sdk = getSDKClient()
  return unwrap<ApiMessageWithParts[]>(
    await sdk.session.messages({
      sessionID: sessionId,
      directory: formatPathForApi(directory),
      limit,
    }),
  )
}

/**
 * 获取 session 的消息数量
 */
export async function getSessionMessageCount(sessionId: string): Promise<number> {
  const messages = await getSessionMessages(sessionId)
  return messages.length
}

// ============================================
// Message Content Extraction
// ============================================

/**
 * 从 API 消息中提取用户消息内容（文本+附件）
 */
export function extractUserMessageContent(message: UserContentSource): RevertedMessage {
  const { parts } = message

  const textParts = parts.filter((part): part is ApiTextPart => isTextUserContentPart(part) && !part.synthetic)
  const text = textParts.map(p => p.text).join('\n')

  const attachments: Attachment[] = []

  const getSourcePath = (source: ApiFilePart['source']): string | undefined => {
    if (!source || !('path' in source)) return undefined
    return source.path
  }

  for (const part of parts) {
    if (isFileUserContentPart(part)) {
      const isFolder = part.mime === 'application/x-directory'
      const sourcePath = getSourcePath(part.source)
      attachments.push({
        id: part.id || crypto.randomUUID(),
        type: isFolder ? 'folder' : 'file',
        displayName: part.filename || sourcePath || 'file',
        url: part.url,
        mime: part.mime,
        relativePath: sourcePath,
        textRange: part.source?.text
          ? {
              value: part.source.text.value,
              start: part.source.text.start,
              end: part.source.text.end,
            }
          : undefined,
      })
    } else if (isAgentUserContentPart(part)) {
      attachments.push({
        id: part.id || crypto.randomUUID(),
        type: 'agent',
        displayName: part.name,
        agentName: part.name,
        textRange: part.source
          ? {
              value: part.source.value,
              start: part.source.start,
              end: part.source.end,
            }
          : undefined,
      })
    }
  }

  return { text, attachments }
}

// ============================================
// Send Message
// ============================================

/**
 * 构建 file:// URL
 */
function toFileUrl(path: string): string {
  if (!path) return ''

  if (path.startsWith('file://')) {
    return path
  }

  if (path.startsWith('data:')) {
    return path
  }

  const normalized = path.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(normalized)) {
    return `file:///${normalized}`
  }
  if (normalized.startsWith('/')) {
    return `file://${normalized}`
  }
  return `file:///${normalized}`
}

/**
 * 构建 SDK 发送消息所需的参数
 */
function buildPromptParams(params: SendMessageParams): PromptParams {
  const { sessionId, text, attachments, model, agent, variant, directory } = params

  const parts: NonNullable<PromptParams['parts']> = []

  // 文本 part
  const textPart: TextPartInput = {
    type: 'text',
    text,
  }
  parts.push(textPart)

  // 附件 parts
  for (const attachment of attachments) {
    if (attachment.type === 'agent') {
      const agentPart: AgentPartInput = {
        type: 'agent',
        name: attachment.agentName || attachment.displayName,
        source: attachment.textRange
          ? {
              value: attachment.textRange.value,
              start: attachment.textRange.start,
              end: attachment.textRange.end,
            }
          : undefined,
      }
      parts.push(agentPart)
    } else {
      const fileUrl = toFileUrl(attachment.url || '')
      if (!fileUrl) {
        console.warn('Skipping attachment with empty URL:', attachment)
        continue
      }

      const filePart: FilePartInput = {
        type: 'file',
        mime: attachment.mime || (attachment.type === 'folder' ? 'application/x-directory' : 'text/plain'),
        url: fileUrl,
        filename: attachment.displayName,
        source: attachment.textRange
          ? {
              text: {
                value: attachment.textRange.value,
                start: attachment.textRange.start,
                end: attachment.textRange.end,
              },
              type: 'file',
              path: attachment.relativePath || attachment.displayName,
            }
          : undefined,
      }
      parts.push(filePart)
    }
  }

  return {
    sessionID: sessionId,
    directory: formatPathForApi(directory),
    parts,
    model,
    agent,
    variant,
  }
}

/**
 * 同步发送消息（等待完成）
 */
export async function sendMessage(params: SendMessageParams): Promise<SendMessageResponse> {
  const sdk = getSDKClient()
  return unwrap<SendMessageResponse>(await sdk.session.prompt(buildPromptParams(params)))
}

/**
 * 异步发送消息 — 立即返回，AI 响应通过 SSE 推送
 */
export async function sendMessageAsync(params: SendMessageParams): Promise<void> {
  const sdk = getSDKClient()
  unwrap(await sdk.session.promptAsync(buildPromptParams(params)))
}
