import type {
  APIError,
  MessageAbortedError,
  MessageOutputLengthError,
  ProviderAuthError,
  UnknownError,
} from '../message'

export interface ErrorInfo {
  name: string
  data: unknown
}

export type { ProviderAuthError, UnknownError, MessageOutputLengthError, MessageAbortedError, APIError }
