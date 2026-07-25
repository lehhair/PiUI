type UnsupportedResult = Promise<never>
export type UnsupportedLegacyClient = {
  readonly [key: string]: UnsupportedLegacyClient
} & ((...args: unknown[]) => UnsupportedResult)

export class UnsupportedPiCapabilityError extends Error {
  readonly code = 'NOT_SUPPORTED'

  constructor(capability: string) {
    super(`${capability} is not supported by the PiUI backend`)
    this.name = 'UnsupportedPiCapabilityError'
  }
}

function unsupportedProxy(path: string): object {
  const callable = () => {
    throw new UnsupportedPiCapabilityError(path)
  }
  return new Proxy(callable, {
    get: (_target, property) => unsupportedProxy(`${path}.${String(property)}`),
    apply: () => {
      throw new UnsupportedPiCapabilityError(path)
    },
  })
}

/** Transitional boundary for UI modules that have not received a Pi capability yet. */
export function getSDKClient(): UnsupportedLegacyClient {
  return unsupportedProxy('legacy API') as UnsupportedLegacyClient
}

export async function getSDKClientAsync(): Promise<UnsupportedLegacyClient> {
  return getSDKClient()
}

export function abortInFlightApiRequests(): void {}
export function invalidateSDKClient(): void {}

export function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error != null) {
    const error = result.error
    if (error instanceof Error) throw error
    throw new Error(typeof error === 'string' ? error : JSON.stringify(error))
  }
  return result.data as T
}
