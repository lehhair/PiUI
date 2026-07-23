import type {
  Pty as SDKPty,
  PtyCreateData as SDKPtyCreateData,
  PtyUpdateData as SDKPtyUpdateData,
} from '@opencode-ai/sdk/v2/client'

export type PtySize = NonNullable<NonNullable<SDKPtyUpdateData['body']>['size']>

export type Pty = SDKPty

export type PtyCreateParams = NonNullable<SDKPtyCreateData['body']>

export type PtyUpdateParams = NonNullable<SDKPtyUpdateData['body']>
