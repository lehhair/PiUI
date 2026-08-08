import type { PiImageInput } from '../../pi/transport/index.js'
import type { Attachment } from '../attachment'

/**
 * 把 data-url 图片附件转换为 Pi 原生 ImageContent 块（base64）。
 * 非图片 / 非 data-url 附件返回 null —— Pi 只接受 ImageContent，
 * 其它附件按路径语义留给 Pi 自身处理，前端不做提取。
 */
export function attachmentToImage(attachment: Attachment): PiImageInput | null {
  if (!attachment.url?.startsWith('data:') || !attachment.mime?.startsWith('image/')) return null
  const commaIndex = attachment.url.indexOf(',')
  if (commaIndex === -1) return null
  return { type: 'image', data: attachment.url.slice(commaIndex + 1), mimeType: attachment.mime }
}
