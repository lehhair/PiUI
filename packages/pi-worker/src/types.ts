/** Pi-like native shapes used by projection. Not full SDK types — no model dependency. */

export interface PiToolCallBlock {
  type: "toolCall"
  id: string
  name: string
  arguments: unknown
}

export interface PiTextBlock {
  type: "text"
  text: string
}

export interface PiThinkingBlock {
  type: "thinking"
  thinking: string
}

export type PiContentBlock = PiTextBlock | PiThinkingBlock | PiToolCallBlock

export interface PiMessageEntry {
  type: "message"
  id: string
  parentId: string | null
  timestamp: number
  message: {
    role: "user" | "assistant" | "toolResult"
    content?: PiContentBlock[] | string
    toolCallId?: string
    toolName?: string
    isError?: boolean
    /** toolResult text content */
    result?: string | Array<{ type: "text"; text: string }>
  }
}

export type PiEntry = PiMessageEntry

export type WorkerEvent =
  | { type: "message_start"; entryId: string; role: "user" | "assistant"; timestamp: number }
  | {
      type: "message_update"
      entryId: string
      content: PiContentBlock[]
    }
  | {
      type: "message_end"
      entryId: string
      role: "user" | "assistant" | "toolResult"
      message: PiMessageEntry["message"]
      parentId: string | null
      timestamp: number
    }
  | {
      type: "tool_execution_start"
      toolCallId: string
      toolName: string
      args: unknown
    }
  | {
      type: "tool_execution_end"
      toolCallId: string
      isError?: boolean
      result?: string
    }
  | { type: "agent_end" }
