import { UnsupportedPiCapabilityError } from './errors'
import { isPiServerUp } from '../pi/httpClient'

export interface HealthInfo {
  healthy: boolean
  version?: string
}

export async function getHealth(): Promise<HealthInfo> {
  return { healthy: await isPiServerUp() }
}

export async function disposeGlobal(): Promise<boolean> {
  throw new UnsupportedPiCapabilityError('global server disposal')
}

export async function disposeInstance(_directory?: string): Promise<boolean> {
  throw new UnsupportedPiCapabilityError('workspace instance disposal')
}
