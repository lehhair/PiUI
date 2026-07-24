// ============================================
// TodoStore - Session Todos State Management
// ============================================
//
// 管理每个 session 的 todos 状态
// 通过 SSE 事件 (todo.updated) 实时更新
//

import { useSyncExternalStore, useCallback } from 'react'
import type { TodoItem } from '../types/api/event'

// ============================================
// Types
// ============================================

export interface SessionTodos {
  todos: TodoItem[]
  lastUpdated: number
}

export interface TodoStats {
  total: number
  completed: number
  inProgress: number
}

type Subscriber = () => void

// 空数组常量，避免每次创建新引用
const EMPTY_TODOS: TodoItem[] = []
const EMPTY_STATS: TodoStats = { total: 0, completed: 0, inProgress: 0 }

// ============================================
// Store Implementation
// ============================================

class TodoStore {
  private sessions = new Map<string, SessionTodos>()
  private statsCache = new Map<string, TodoStats>()
  private subscribers = new Set<Subscriber>()
  private version = 0

  // ============================================
  // Public API
  // ============================================

  /**
   * 获取 session 的 todos
   */
  getTodos(sessionId: string): TodoItem[] {
    return this.sessions.get(sessionId)?.todos || EMPTY_TODOS
  }

  /**
   * 设置 session 的 todos（通常由 SSE 事件触发）
   */
  setTodos(sessionId: string, todos: TodoItem[]) {
    this.sessions.set(sessionId, {
      todos,
      lastUpdated: Date.now(),
    })
    // 更新 stats 缓存
    this.statsCache.set(sessionId, {
      total: todos.length,
      completed: todos.filter(t => t.status === 'completed').length,
      inProgress: todos.filter(t => t.status === 'in_progress').length,
    })
    this.version++
    this.notify()
  }

  /**
   * 清除 session 的 todos
   */
  clearTodos(sessionId: string) {
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId)
      this.statsCache.delete(sessionId)
      this.version++
      this.notify()
    }
  }

  /**
   * 清空所有数据（服务器切换时调用）
   */
  clearAll() {
    this.sessions.clear()
    this.statsCache.clear()
    this.version++
    this.notify()
  }

  /**
   * 获取 todos 统计信息（缓存版本）
   */
  getStats(sessionId: string): TodoStats {
    return this.statsCache.get(sessionId) || EMPTY_STATS
  }

  /**
   * 获取当前正在进行的任务
   */
  getCurrentTask(sessionId: string): TodoItem | null {
    const todos = this.getTodos(sessionId)
    return todos.find(t => t.status === 'in_progress') || null
  }

  /**
   * 获取版本号（用于 useSyncExternalStore）
   */
  getVersion(): number {
    return this.version
  }

  // ============================================
  // Subscription
  // ============================================

  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  private notify() {
    this.subscribers.forEach(fn => fn())
  }
}

// ============================================
// Singleton Export
// ============================================

export const todoStore = new TodoStore()

// ============================================
// React Hooks
// ============================================

/**
 * 订阅 store 变化
 */
function useStoreSubscription() {
  return useSyncExternalStore(
    useCallback(callback => todoStore.subscribe(callback), []),
    useCallback(() => todoStore.getVersion(), []),
  )
}

/**
 * 订阅 session 的 todos
 */
export function useTodos(sessionId: string | null): TodoItem[] {
  useStoreSubscription()
  return sessionId ? todoStore.getTodos(sessionId) : EMPTY_TODOS
}

/**
 * 获取 todos 统计信息
 */
export function useTodoStats(sessionId: string | null): TodoStats {
  useStoreSubscription()
  return sessionId ? todoStore.getStats(sessionId) : EMPTY_STATS
}

/**
 * 获取当前进行中的任务
 */
export function useCurrentTask(sessionId: string | null): TodoItem | null {
  useStoreSubscription()
  return sessionId ? todoStore.getCurrentTask(sessionId) : null
}
