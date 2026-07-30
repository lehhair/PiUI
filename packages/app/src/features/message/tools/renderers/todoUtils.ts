import type { PiToolExecution } from '../../../../pi/domain/index.js'

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

export function extractTodos(execution: PiToolExecution): TodoItem[] {
  const inputObj = execution.call.arguments as Record<string, unknown> | undefined
  const details = execution.result?.details as Record<string, unknown> | undefined
  return (details?.todos as TodoItem[]) || (inputObj?.todos as TodoItem[]) || []
}

export function hasTodos(execution: PiToolExecution): boolean {
  return extractTodos(execution).length > 0
}
