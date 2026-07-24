import { memo } from 'react'
import { MarkdownRenderer } from '../../../components'
import type { TextPart } from '../../../types/message'

interface TextPartViewProps {
  part: TextPart
  isStreaming?: boolean
}

/**
 * TextPartView - 直接渲染后端推送的文本，无缓冲延迟
 */
export const TextPartView = memo(function TextPartView({ part, isStreaming = false }: TextPartViewProps) {
  const displayText = part.text || ''

  // 跳过空文本（除非正在 streaming）
  if (!displayText.trim() && !isStreaming) return null

  // 跳过 synthetic 文本（系统上下文，单独处理）
  if (part.synthetic) return null

  return (
    <div style={{ contain: 'layout' }}>
      <MarkdownRenderer content={displayText} isStreaming={isStreaming} />
    </div>
  )
})
