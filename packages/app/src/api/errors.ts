export class UnsupportedPiCapabilityError extends Error {
  readonly code = 'NOT_SUPPORTED'

  constructor(capability: string) {
    super(`${capability} is not supported by the PiUI backend`)
    this.name = 'UnsupportedPiCapabilityError'
  }
}
