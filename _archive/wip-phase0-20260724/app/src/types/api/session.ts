import type {
  Session as SDKSession,
  SessionCreateData as SDKSessionCreateData,
  SessionForkData as SDKSessionForkData,
  SessionListData as SDKSessionListData,
  SessionStatus as SDKSessionStatus,
  SessionUpdateData as SDKSessionUpdateData,
} from '@opencode-ai/sdk/v2/client'

export type SessionStatus = SDKSessionStatus

export type SessionStatusMap = Record<string, SessionStatus>

export type SessionSummary = NonNullable<SDKSession['summary']>

export type SessionShare = NonNullable<SDKSession['share']>

export type SessionRevert = NonNullable<SDKSession['revert']>

export type Session = SDKSession

export type SessionListParams = NonNullable<SDKSessionListData['query']>

export type SessionCreateParams = NonNullable<SDKSessionCreateData['query']> & NonNullable<SDKSessionCreateData['body']>

export type SessionUpdateParams = NonNullable<SDKSessionUpdateData['body']>

export type SessionForkParams = NonNullable<SDKSessionForkData['query']> & NonNullable<SDKSessionForkData['body']>
