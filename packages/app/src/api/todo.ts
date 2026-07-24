import type { Todo as SDKTodo } from '@opencode-ai/sdk/v2/client'
import type { TodoItem } from '../types/api/event'

function buildTodoId(todo: SDKTodo, index: number): string {
  const content = String(todo.content ?? '').slice(0, 32)
  const status = String(todo.status ?? '')
  const priority = String(todo.priority ?? '')
  return `todo-${index}-${content}-${status}-${priority}`
}

function isTodoStatus(status: string): status is TodoItem['status'] {
  return status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'cancelled'
}

function isTodoPriority(priority: string): priority is TodoItem['priority'] {
  return priority === 'high' || priority === 'medium' || priority === 'low'
}

function normalizeTodoStatus(status: string): TodoItem['status'] {
  return isTodoStatus(status) ? status : 'pending'
}

function normalizeTodoPriority(priority: string): TodoItem['priority'] {
  return isTodoPriority(priority) ? priority : 'medium'
}

export function normalizeTodoItems(todos: SDKTodo[] | null | undefined): TodoItem[] {
  return (todos ?? []).map((todo, index) => ({
    id: buildTodoId(todo, index),
    content: todo.content,
    status: normalizeTodoStatus(todo.status),
    priority: normalizeTodoPriority(todo.priority),
  }))
}
