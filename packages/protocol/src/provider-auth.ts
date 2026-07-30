import type { JsonObject, JsonValue } from "./json.js"

/**
 * Provider authentication flow events, streamed on the `provider.auth`
 * channel (provider stream). Shapes mirror the worker's ProviderAuthHost.
 */
export type ProviderAuthEvent =
  | { type: "prompt"; flowId: string; promptId: string; providerId: string; prompt: JsonObject }
  | { type: "notification"; flowId: string; providerId: string; event: JsonValue }
  | { type: "completed"; flowId: string; providerId: string }
  | { type: "failed"; flowId: string; providerId: string; message: string }
  | { type: "cancelled"; flowId: string; providerId: string }

/** Prompt payload inside a `prompt` event (select or free-form input). */
export type ProviderAuthPromptOption = {
  id: string
  label: string
  description?: string
}

export type ProviderAuthPrompt = {
  /** 'select' shows radio options; 'secret' masks input; anything else is plain text. */
  type?: string
  message?: string
  placeholder?: string
  options?: ProviderAuthPromptOption[]
}
