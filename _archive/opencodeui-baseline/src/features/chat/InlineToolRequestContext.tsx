/**
 * InlineToolRequestContext
 *
 * 把待处理的权限请求和提问请求注入到消息流里，
 * 让工具视图可以在对应位置直接渲染内嵌交互。
 * 对于 task 类型的 tool，还支持匹配子 session 内部的请求。
 */

import { createContext, useContext } from 'react'
import type { ApiPermissionRequest, ApiQuestionRequest, PermissionReply, QuestionAnswer } from '../../api'
import { childSessionStore } from '../../store'

export interface InlineToolRequestContextValue {
  /** 当前 pending 的权限请求 */
  pendingPermissions: ApiPermissionRequest[]
  /** 当前 pending 的提问请求 */
  pendingQuestions: ApiQuestionRequest[]
  /** 回复权限 */
  onPermissionReply: (requestId: string, reply: PermissionReply) => void
  /** 回复提问 */
  onQuestionReply: (requestId: string, answers: QuestionAnswer[]) => void
  /** 拒绝提问 */
  onQuestionReject: (requestId: string) => void
  /** 是否正在发送回复 */
  isReplying: boolean
}

const defaultValue: InlineToolRequestContextValue = {
  pendingPermissions: [],
  pendingQuestions: [],
  onPermissionReply: () => {},
  onQuestionReply: () => {},
  onQuestionReject: () => {},
  isReplying: false,
}

export const InlineToolRequestContext = createContext<InlineToolRequestContextValue>(defaultValue)

export function useInlineToolRequests() {
  return useContext(InlineToolRequestContext)
}

/**
 * 根据 callID 查找关联的权限请求。
 * 对于 task tool，额外传入 childSessionId，
 * 匹配子 session（及其子孙）内部发出的权限请求。
 */
export function findPermissionRequestForTool(
  pendingPermissions: ApiPermissionRequest[],
  callID: string,
  childSessionId?: string,
): ApiPermissionRequest | undefined {
  // 先按 callID 精确匹配（直接工具调用）
  const direct = pendingPermissions.find(p => p.tool?.callID === callID)
  if (direct) return direct

  // 对 task tool，按子 session 归属匹配
  if (childSessionId) {
    return pendingPermissions.find(
      p => p.sessionID === childSessionId || childSessionStore.isChildOf(p.sessionID, childSessionId),
    )
  }

  return undefined
}

/**
 * 根据 callID 查找关联的提问请求。
 * 对于 task tool，额外传入 childSessionId。
 */
export function findQuestionRequestForTool(
  pendingQuestions: ApiQuestionRequest[],
  callID: string,
  childSessionId?: string,
): ApiQuestionRequest | undefined {
  const direct = pendingQuestions.find(q => q.tool?.callID === callID)
  if (direct) return direct

  if (childSessionId) {
    return pendingQuestions.find(
      q => q.sessionID === childSessionId || childSessionStore.isChildOf(q.sessionID, childSessionId),
    )
  }

  return undefined
}
