import { memo, useMemo } from 'react'
import { useSyntaxHighlight } from '../hooks/useSyntaxHighlight'
import { CopyButton } from './ui'

/**
 * JSON 数据展示 — 走 shiki 语法高亮（与代码块同色系），
 * 高亮未就绪时先渲染纯文本，避免闪烁。
 * 右上角浮动复制按钮，交互与 CodeBlock 一致。
 * memo 包裹：value 引用不变时跳过重渲染，避免父组件每次击键
 * 都重建几千个高亮 span。
 */
export const JsonView = memo(function JsonView({ value, className }: { value: unknown; className?: string }) {
  const code = useMemo(() => JSON.stringify(value, null, 2) ?? '', [value])
  const { output } = useSyntaxHighlight(code, { lang: 'json', mode: 'tokens' })

  return (
    <div className="group/json relative">
      <div className="absolute top-2 right-2 z-10 opacity-0 group-hover/json:opacity-100 group-focus-within/json:opacity-100 transition-opacity">
        <CopyButton
          text={code}
          position="static"
          className="!h-8 !w-8 !p-2 rounded-md bg-bg-300/70 backdrop-blur-md"
        />
      </div>
      <pre className={`overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-200/40 p-2 font-mono text-[length:var(--fs-xs)] ${className ?? ''}`}>
        {output
          ? output.map((line, lineIndex) => (
              <span key={lineIndex}>
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>{token.content}</span>
                ))}
                {lineIndex < output.length - 1 ? '\n' : null}
              </span>
            ))
          : <span className="text-text-400">{code}</span>}
      </pre>
    </div>
  )
})
