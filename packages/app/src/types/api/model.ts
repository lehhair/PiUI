export interface ModelIOCapabilities {
  text?: boolean
  image?: boolean
  pdf?: boolean
  audio?: boolean
  video?: boolean
}

export interface ModelCapabilities {
  input: ModelIOCapabilities
  output?: ModelIOCapabilities
  toolcall?: boolean
  reasoning?: boolean
}

export interface ModelLimit {
  context?: number
  output?: number
}

export type ModelStatus = 'available' | 'unavailable' | 'deprecated'

export interface Model {
  id: string
  name: string
  providerID: string
  capabilities: ModelCapabilities
  limit?: ModelLimit
  status?: ModelStatus
}

export interface Provider {
  id: string
  name: string
  models: Record<string, Model>
}

export interface ProvidersResponse {
  providers: Provider[]
}

export type ProviderAuthMethod = 'api' | 'oauth' | 'none'

export interface ProviderAuthAuthorization {
  url: string
  method?: ProviderAuthMethod
}
