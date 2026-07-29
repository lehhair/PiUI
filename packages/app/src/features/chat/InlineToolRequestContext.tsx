/**
 * InlineToolRequestContext
 *
 * 把待处理的权限请求和提问请求注入到消息流里，
 * 让工具视图可以在对应位置直接渲染内嵌交互。
 */

import { createContext, useContext } from 'react'
import type { ApiPermissionRequest, ApiQuestionRequest, PermissionReply, QuestionAnswer } from '../../api'

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
 */
export function findPermissionRequestForTool(
  pendingPermissions: ApiPermissionRequest[],
  callID: string,
  childSessionId?: string,
): ApiPermissionRequest | undefined {
  const direct = pendingPermissions.find(p => p.tool?.callID === callID)
  if (direct) return direct

  if (childSessionId) {
    return pendingPermissions.find(p => p.sessionID === childSessionId)
  }

  return undefined
}

/**
 * 根据 callID 查找关联的提问请求。
 */
export function findQuestionRequestForTool(
  pendingQuestions: ApiQuestionRequest[],
  callID: string,
  childSessionId?: string,
): ApiQuestionRequest | undefined {
  const direct = pendingQuestions.find(q => q.tool?.callID === callID)
  if (direct) return direct

  if (childSessionId) {
    return pendingQuestions.find(q => q.sessionID === childSessionId)
  }

  return undefined
}
