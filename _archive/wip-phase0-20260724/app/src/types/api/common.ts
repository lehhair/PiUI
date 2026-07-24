import type {
  ApiError as SDKApiError,
  MessageAbortedError as SDKMessageAbortedError,
  MessageOutputLengthError as SDKMessageOutputLengthError,
  ProviderAuthError as SDKProviderAuthError,
  UnknownError as SDKUnknownError,
} from '@opencode-ai/sdk/v2/client'

export interface ErrorInfo {
  name: string
  data: unknown
}

export type ProviderAuthError = SDKProviderAuthError

export type UnknownError = SDKUnknownError

export type MessageOutputLengthError = SDKMessageOutputLengthError

export type MessageAbortedError = SDKMessageAbortedError

export type APIError = SDKApiError
