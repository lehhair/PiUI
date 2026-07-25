import { UnsupportedPiCapabilityError } from './errors'
import type { Config } from '../types/api/config'
import type { ProvidersResponse } from '../types/api/model'

export async function getConfig(_directory?: string): Promise<Config> {
  return {}
}

export async function getGlobalConfig(): Promise<Config> {
  return {}
}

export async function updateConfig(_config: Config, _directory?: string): Promise<Config> {
  throw new UnsupportedPiCapabilityError('Pi configuration updates')
}

export async function updateGlobalConfig(_config: Config): Promise<Config> {
  throw new UnsupportedPiCapabilityError('Pi configuration updates')
}

export async function getProviderConfigs(_directory?: string): Promise<ProvidersResponse> {
  return { providers: [] }
}
