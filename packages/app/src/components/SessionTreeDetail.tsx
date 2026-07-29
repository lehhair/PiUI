import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { nativeEntriesToUiMessages } from '../pi/nativeEntriesToMessages'
import type { NativeEntry, NativeTreeNode } from './sessionTreeGraph'

interface SessionTreeDetailProps {
  sessionId: string
  directory: string
  node: NativeTreeNode
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const item of content) {
    const record = asRecord(item)
    if (record.type === 'text' && typeof record.text === 'string') text += record.text
  }
  return text
}

function collectToolResults(tree: NativeTreeNode[], toolCallId: string): Array<{ content: unknown; details: unknown; isError: boolean; timestamp: string }> {
  const results: Array<{ content: unknown; details: unknown; isError: boolean; timestamp: string }> = []
  const stack = [...tree]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.entry.type === 'message') {
      const message = asRecord(node.entry.message)
      if (message.role === 'toolResult' && message.toolCallId === toolCallId) {
        results.push({
          content: message.content ?? message.result,
          details: message.details,
          isError: message.isError === true,
          timestamp: typeof node.entry.timestamp === 'string' ? node.entry.timestamp : '',
        })
      }
    }
    stack.push(...node.children)
  }
  return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

function collectDescendants(node: NativeTreeNode): NativeEntry[] {
  const entries: NativeEntry[] = []
  const stack = [...node.children]
  while (stack.length > 0) {
    const child = stack.pop()!
    entries.push(child.entry)
    stack.push(...child.children)
  }
  return entries
}

function ToolExecutionDetail({ toolName, args, results, t }: {
  toolName: string
  args: unknown
  results: Array<{ content: unknown; details: unknown; isError: boolean; timestamp: string }>
  t: (key: string) => string
}) {
  const hasResult = results.length > 0
  const latest = results.at(-1)
  const output = latest ? textFromContent(latest.content) : ''
  const details = latest ? asRecord(latest.details) : {}
  const patch = typeof details.patch === 'string' ? details.patch : typeof details.diff === 'string' ? details.diff : ''
  const cwd = typeof details.cwd === 'string' ? details.cwd : ''
  const exitCode = typeof details.exitCode === 'number' ? details.exitCode : undefined

  return (
    <div className="rounded border border-border-200/50 bg-bg-200/30 px-2.5 py-1.5">
      <div className="flex items-center gap-2 text-[length:var(--fs-xs)] font-medium text-text-300">
        <span className="rounded bg-bg-300/60 px-1.5 py-0.5 text-text-200">{toolName}</span>
        {hasResult ? (
          <span className={latest?.isError ? 'text-danger-100' : 'text-success-100'}>
            {latest?.isError ? t('sessionTree.toolError') : t('sessionTree.toolCompleted')}
          </span>
        ) : (
          <span className="text-text-500">{t('sessionTree.toolPending')}</span>
        )}
      </div>
      {args && Object.keys(asRecord(args)).length > 0 ? (
        <pre className="mt-1 overflow-x-auto text-[length:var(--fs-xxs)] leading-relaxed text-text-400 whitespace-pre-wrap break-words">
          {JSON.stringify(args, null, 2)}
        </pre>
      ) : null}
      {output ? (
        <div className="mt-1 max-h-24 overflow-y-auto">
          <pre className="text-[length:var(--fs-xxs)] leading-relaxed text-text-300 whitespace-pre-wrap break-words">
            {output}
          </pre>
        </div>
      ) : null}
      {patch ? (
        <div className="mt-1 max-h-20 overflow-y-auto rounded border border-border-200/30 bg-bg-100/50 p-1.5">
          <pre className="text-[length:var(--fs-xxs)] leading-relaxed text-text-400 whitespace-pre-wrap break-words font-mono">
            {patch}
          </pre>
        </div>
      ) : null}
      {cwd || exitCode !== undefined ? (
        <div className="mt-1 flex items-center gap-2 text-[length:var(--fs-xxs)] text-text-500">
          {cwd ? <span>cwd: {cwd}</span> : null}
          {exitCode !== undefined ? <span>exit: {exitCode}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

export const SessionTreeDetail = memo(function SessionTreeDetail({
  sessionId,
  directory,
  node,
}: SessionTreeDetailProps) {
  const { t } = useTranslation('components')
  const entry = node.entry
  const type = typeof entry.type === 'string' ? entry.type : 'unknown'
  const message = type === 'message' ? asRecord(entry.message) : undefined
  const role = message ? String(message.role ?? '') : undefined
  const content = message?.content
  const text = content ? textFromContent(content) : ''
  const toolCalls = Array.isArray(content)
    ? content.flatMap(block => {
        const record = asRecord(block)
        if (record.type === 'toolCall' && typeof record.id === 'string') {
          return [{ id: record.id, name: typeof record.name === 'string' ? record.name : 'tool', args: record.arguments }]
        }
        return []
      })
    : []

  const descendants = useMemo(() => collectDescendants(node), [node])
  const allEntries = useMemo(() => [entry, ...descendants], [entry, descendants])

  const messages = useMemo(() => {
    if (type !== 'message') return []
    return nativeEntriesToUiMessages(allEntries, {
      sessionId,
      directory,
      model: undefined,
    })
  }, [allEntries, directory, sessionId, type])

  const assistantMessage = useMemo(() => {
    return messages.find(m => m.info.role === 'assistant')
  }, [messages])

  const toolResultsByCallId = useMemo(() => {
    const map = new Map<string, Array<{ content: unknown; details: unknown; isError: boolean; timestamp: string }>>()
    for (const call of toolCalls) {
      map.set(call.id, collectToolResults([node], call.id))
    }
    return map
  }, [node, toolCalls])

  const fullText = useMemo(() => {
    if (type === 'message') {
      if (role === 'assistant' && assistantMessage) {
        const textParts = assistantMessage.parts.filter(p => p.type === 'text')
        return textParts.map(p => p.text).join('\n')
      }
      return text
    }
    if (type === 'compaction' || type === 'branch_summary') {
      return String(entry.summary ?? '')
    }
    if (type === 'custom_message') {
      return textFromContent(entry.content)
    }
    return ''
  }, [assistantMessage, entry.content, entry.summary, role, text, type])

  const isAssistant = role === 'assistant'
  const isEvent = type === 'compaction' || type === 'branch_summary'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-2.5 py-1.5">
        {fullText ? (
          <div className="mb-2 break-words text-[length:var(--fs-xs)] leading-relaxed text-text-200 whitespace-pre-wrap">
            {fullText}
          </div>
        ) : null}

        {isAssistant && toolCalls.length > 0 ? (
          <div className="space-y-1.5">
            {toolCalls.map(call => (
              <ToolExecutionDetail
                key={call.id}
                toolName={call.name}
                args={call.args}
                results={toolResultsByCallId.get(call.id) ?? []}
                t={t}
              />
            ))}
          </div>
        ) : null}

        {isAssistant && assistantMessage?.isStreaming ? (
          <p className="mt-1.5 text-[length:var(--fs-xs)] text-text-500">{t('sessionTree.streaming')}</p>
        ) : null}

        {isAssistant && assistantMessage?.info.role === 'assistant' && assistantMessage.info.finish === 'aborted' ? (
          <p className="mt-1.5 text-[length:var(--fs-xs)] text-danger-100">{t('sessionTree.aborted')}</p>
        ) : null}

        {isAssistant && assistantMessage?.info.role === 'assistant' && assistantMessage.info.finish === 'error' ? (
          <p className="mt-1.5 text-[length:var(--fs-xs)] text-danger-100">{t('sessionTree.error')}</p>
        ) : null}

        {isEvent && fullText ? null : isEvent ? (
          <p className="text-[length:var(--fs-xs)] text-text-400">{t('sessionTree.noContent')}</p>
        ) : null}
      </div>
    </div>
  )
})
