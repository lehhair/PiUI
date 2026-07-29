import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { UserMessage, AssistantMessage, ToolResultMessage, TextContent, ThinkingContent, ToolCall } from '@earendil-works/pi-ai'
import type {
  PiSessionRow,
  PiTimelineItem,
  PiUserMessageItem,
  PiAssistantMessageItem,
  PiToolExecutionItem,
  PiCompactionItem,
  PiBranchSummaryItem,
  PiModelChangeItem,
  PiThinkingLevelItem,
  PiCustomMessageItem,
  PiLabelItem,
  PiUnknownItem,
} from '../domain/index.js'
import { piSessionInfoStore } from '../state/index.js'

/**
 * Select Pi session rows from raw session info.
 * Transforms SessionInfo to UI-ready session rows.
 */
export function selectPiSessionRows(): PiSessionRow[] {
  const sessions = piSessionInfoStore.getAll()
  return sessions
    .filter(session => session.id && session.cwd && session.path)
    .map(session => ({
      id: session.id,
      sessionFile: session.path,
      cwd: session.cwd,
      title: session.name || session.firstMessage || 'New chat',
      preview: session.firstMessage,
      createdAt: parseTime(session.created),
      modifiedAt: parseTime(session.modified) || parseTime(session.created),
      messageCount: session.messageCount ?? 0,
      parentSessionPath: session.parentSessionPath,
    }))
}

/**
 * Select timeline items from raw session entries.
 * Groups message entries into user/assistant/tool items.
 */
export function selectPiTimelineItems(entries: SessionEntry[]): PiTimelineItem[] {
  const items: PiTimelineItem[] = []
  const toolCallMap = new Map<string, { call: ToolCall; result?: ToolResultMessage; entryId: string; timestamp: number }>()

  for (const entry of entries) {
    const timestamp = parseTime(entry.timestamp)

    if (entry.type === 'message') {
      const message = entry.message as AgentMessage

      if (message.role === 'user') {
        const userMsg = message as UserMessage
        items.push({
          kind: 'user_message',
          entryId: entry.id,
          timestamp,
          rawEntry: entry,
          message: userMsg,
          blocks: Array.isArray(userMsg.content) ? userMsg.content : [{ type: 'text', text: userMsg.content }],
        } as PiUserMessageItem)
      } else if (message.role === 'assistant') {
        const assistantMsg = message as AssistantMessage
        const toolCalls: ToolCall[] = []
        const blocks: (TextContent | ThinkingContent)[] = []

        for (const block of assistantMsg.content) {
          if (block.type === 'toolCall') {
            toolCalls.push(block)
          } else {
            blocks.push(block)
          }
        }

        items.push({
          kind: 'assistant_message',
          entryId: entry.id,
          timestamp,
          rawEntry: entry,
          message: assistantMsg,
          blocks,
        } as PiAssistantMessageItem)

        // Track tool calls for pairing with results
        for (const call of toolCalls) {
          toolCallMap.set(call.id, { call, entryId: entry.id, timestamp })
        }
      } else if (message.role === 'toolResult') {
        const toolResult = message as ToolResultMessage
        const tracked = toolCallMap.get(toolResult.toolCallId)

        if (tracked) {
          // Found matching tool call, create tool execution item
          items.push({
            kind: 'tool_execution',
            entryId: entry.id,
            timestamp,
            rawEntry: entry,
            toolCallId: toolResult.toolCallId,
            toolName: toolResult.toolName,
            call: tracked.call,
            result: toolResult,
            status: toolResult.isError ? 'error' : 'completed',
          } as PiToolExecutionItem)
          toolCallMap.delete(toolResult.toolCallId)
        }
      }
    } else if (entry.type === 'compaction') {
      items.push({
        kind: 'compaction',
        entryId: entry.id,
        timestamp,
        rawEntry: entry,
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        firstKeptEntryId: entry.firstKeptEntryId,
        details: entry.details,
      } as PiCompactionItem)
    } else if (entry.type === 'branch_summary') {
      items.push({
        kind: 'branch_summary',
        entryId: entry.id,
        timestamp,
        rawEntry: entry,
        summary: entry.summary,
        fromId: entry.fromId,
        details: entry.details,
      } as PiBranchSummaryItem)
    } else if (entry.type === 'model_change') {
      items.push({
        kind: 'model_change',
        entryId: entry.id,
        timestamp,
        rawEntry: entry,
        provider: entry.provider,
        modelId: entry.modelId,
      } as PiModelChangeItem)
    } else if (entry.type === 'thinking_level_change') {
      items.push({
        kind: 'thinking_level_change',
        entryId: entry.id,
        timestamp,
        rawEntry: entry,
        thinkingLevel: entry.thinkingLevel,
      } as PiThinkingLevelItem)
    } else if (entry.type === 'custom_message') {
      items.push({
        kind: 'custom_message',
        entryId: entry.id,
        timestamp,
        rawEntry: entry,
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
      } as PiCustomMessageItem)
    } else if (entry.type === 'label') {
      items.push({
        kind: 'label',
        entryId: entry.id,
        timestamp,
        rawEntry: entry,
        targetId: entry.targetId,
        label: entry.label,
      } as PiLabelItem)
    } else {
      // Unknown entry type, keep as unknown item
      items.push({
        kind: 'unknown',
        entryId: entry.id,
        timestamp,
        rawEntry: entry,
        entryType: entry.type,
      } as PiUnknownItem)
    }
  }

  // Add any remaining tool calls without results as pending
  for (const [toolCallId, tracked] of toolCallMap) {
    items.push({
      kind: 'tool_execution',
      entryId: tracked.entryId,
      timestamp: tracked.timestamp,
      rawEntry: entries.find(e => e.id === tracked.entryId)!,
      toolCallId,
      toolName: tracked.call.name,
      call: tracked.call,
      status: 'pending',
    } as PiToolExecutionItem)
  }

  return items
}

/**
 * Select composer mode from session runtime state.
 */
export function selectPiComposerMode(state: { isStreaming?: boolean; steeringMode?: string; followUpMode?: string } | null): { type: 'idle' } | { type: 'streaming'; mode: 'steering' | 'followUp'; queueMode: 'all' | 'one-at-a-time' } {
  if (!state) return { type: 'idle' }
  if (state.isStreaming) {
    return {
      type: 'streaming',
      mode: state.steeringMode === 'one-at-a-time' ? 'steering' : 'followUp',
      queueMode: (state.steeringMode === 'one-at-a-time' ? state.steeringMode : state.followUpMode) as 'all' | 'one-at-a-time' || 'all',
    }
  }
  return { type: 'idle' }
}

/**
 * Select current model info from session runtime state.
 */
export function selectPiCurrentModel(state: { model?: { provider: string; modelId: string }; thinkingLevel?: string } | null): { provider: string; modelId: string; thinkingLevel?: ThinkingLevel } | null {
  if (!state?.model) return null
  return {
    provider: state.model.provider,
    modelId: state.model.modelId,
    thinkingLevel: state.thinkingLevel as ThinkingLevel | undefined,
  }
}

function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}
