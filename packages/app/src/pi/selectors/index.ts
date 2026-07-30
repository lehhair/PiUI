import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type {
  PiBranchPage,
  PiSessionRow,
  PiTimelineItem,
  PiAssistantMessageItem,
  PiCompactionItem,
  PiBranchSummaryItem,
  PiCustomMessageItem,
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
 * Select timeline items from the branch page.
 * Tool results are paired back into their owning assistant item so each
 * message keeps its embedded tool calls. The live streaming message (from
 * the branch checkpoint) is appended as a streaming assistant item.
 * Entries without a conversation representation still surface as items.
 */
export function selectPiTimelineItems(branch: PiBranchPage): PiTimelineItem[] {
  const items: PiTimelineItem[] = []
  const assistantByCallId = new Map<string, PiAssistantMessageItem>()

  for (const entry of branch.items) {
    const timestamp = parseTime(entry.timestamp)

    if (entry.type === 'message') {
      const message = entry.message

      if (message.role === 'user') {
        items.push({
          kind: 'user_message',
          entryId: entry.id,
          timestamp,
          rawEntry: entry,
          message,
          blocks: Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }],
        })
      } else if (message.role === 'assistant') {
        const item: PiAssistantMessageItem = {
          kind: 'assistant_message',
          entryId: entry.id,
          timestamp,
          rawEntry: entry,
          message,
          blocks: message.content,
          toolResults: {},
        }
        items.push(item)
        for (const block of message.content) {
          if (block.type === 'toolCall') assistantByCallId.set(block.id, item)
        }
      } else if (message.role === 'toolResult') {
        const owner = assistantByCallId.get(message.toolCallId)
        if (owner) owner.toolResults[message.toolCallId] = message
      } else if (message.role === 'bashExecution') {
        items.push({
          kind: 'bash_execution',
          entryId: entry.id,
          timestamp,
          rawEntry: entry,
          message,
        })
      }
      // role custom is persisted as custom_message entry; summary roles are
      // runtime projections — neither exists in persisted entries.
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
    } else if (
      entry.type === 'thinking_level_change' ||
      entry.type === 'model_change' ||
      entry.type === 'label' ||
      entry.type === 'custom' ||
      entry.type === 'session_info'
    ) {
      // Not consumed in the conversation flow: model and thinking level
      // live in the header model selector / composer level selector
      // (repeated model_change entries are just noise here), labels are
      // markers on their target entries, plain custom entries are
      // extension state for reload reconstruction, session_info is
      // metadata (name lives in the header/session list).
      continue
    } else {
      // Unknown entry type (future SDK additions) — keep visible, never drop
      const unknown = entry as { id: string; type: string }
      items.push({
        kind: 'unknown',
        entryId: unknown.id,
        timestamp,
        rawEntry: entry,
        entryType: unknown.type,
      } as PiUnknownItem)
    }
  }

  // Append the live streaming message as a streaming assistant item.
  // Present only while streaming; cleared once the entry persists.
  // Skip empty content (message_start before first update) — nothing to show.
  const live = branch.checkpoint?.liveMessage
  if (live && live.message.role === 'assistant' && live.message.content.length > 0) {
    const message = live.message as AssistantMessage
    items.push({
      kind: 'assistant_message',
      entryId: live.id,
      timestamp: message.timestamp || Date.now(),
      rawEntry: {
        type: 'message',
        id: live.id,
        parentId: null,
        timestamp: new Date(message.timestamp || Date.now()).toISOString(),
        message,
      },
      message,
      blocks: message.content,
      toolResults: {},
      isStreaming: true,
    })
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
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}
