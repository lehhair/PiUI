// Permission and question transport is not part of PiUI protocol v1.

import { UnsupportedPiCapabilityError } from './sdk'
import type { ApiPermissionRequest, PermissionReply, ApiQuestionRequest, QuestionAnswer } from './types'

export async function getPendingPermissions(
  _sessionId?: string,
  _directory?: string,
): Promise<ApiPermissionRequest[]> {
  return []
}

export async function replyPermission(
  _requestId: string,
  _reply: PermissionReply,
  _message?: string,
  _directory?: string,
  _sessionId?: string,
): Promise<boolean> {
  throw new UnsupportedPiCapabilityError('permission replies')
}

export async function getPendingQuestions(
  _sessionId?: string,
  _directory?: string,
): Promise<ApiQuestionRequest[]> {
  return []
}

export async function replyQuestion(
  _requestId: string,
  _answers: QuestionAnswer[],
  _directory?: string,
): Promise<boolean> {
  throw new UnsupportedPiCapabilityError('question replies')
}

export async function rejectQuestion(_requestId: string, _directory?: string): Promise<boolean> {
  throw new UnsupportedPiCapabilityError('question replies')
}
