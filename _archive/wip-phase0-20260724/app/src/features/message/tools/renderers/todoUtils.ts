import type { ToolPart } from '../../../../types/message'

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

export function extractTodos(part: ToolPart): TodoItem[] {
  const { state } = part
  const metadata = state.metadata as Record<string, unknown> | undefined
  const inputObj = state.input as Record<string, unknown> | undefined
  return (metadata?.todos as TodoItem[]) || (inputObj?.todos as TodoItem[]) || []
}

export function hasTodos(part: ToolPart): boolean {
  return extractTodos(part).length > 0
}
