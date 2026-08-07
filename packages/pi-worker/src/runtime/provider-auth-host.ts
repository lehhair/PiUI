import { randomUUID } from "node:crypto"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { JsonObject, JsonValue } from "@piui/protocol"
import { requireJsonValue } from "@piui/protocol"
import { getLoadedSdk } from "../sdk-host.js"

const AUTH_FLOW_TIMEOUT_MS = 5 * 60_000

export type ProviderAuthEvent =
  | { type: "prompt"; flowId: string; promptId: string; providerId: string; prompt: JsonObject }
  | { type: "notification"; flowId: string; providerId: string; event: JsonValue }
  | { type: "completed"; flowId: string; providerId: string }
  | { type: "failed"; flowId: string; providerId: string; message: string }
  | { type: "cancelled"; flowId: string; providerId: string }

interface PendingPrompt {
  flowId: string
  resolve: (value: string) => void
  reject: (error: Error) => void
  removeAbort?: () => void
}

interface AuthFlow {
  providerId: string
  controller: AbortController
  promptIds: Set<string>
  timer?: NodeJS.Timeout
}

export class ProviderAuthHost {
  private readonly listeners = new Set<(event: ProviderAuthEvent) => void>()
  private readonly flows = new Map<string, AuthFlow>()
  private readonly prompts = new Map<string, PendingPrompt>()
  private readonly runtimeApiKeys = new Map<string, string>()
  private runtimePromise?: Promise<ModelRuntime>

  constructor(private readonly createRuntime?: () => Promise<ModelRuntime>) {}

  onEvent(listener: (event: ProviderAuthEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async listProviders(): Promise<JsonValue> {
    const runtime = await this.runtime()
    return requireJsonValue(runtime.getProviders().map(provider => ({
      id: provider.id,
      name: provider.name,
      methods: [
        ...(provider.auth.apiKey ? [{
          type: "api_key" as const,
          name: provider.auth.apiKey.name,
          loginAvailable: Boolean(provider.auth.apiKey.login),
        }] : []),
        ...(provider.auth.oauth ? [{
          type: "oauth" as const,
          name: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
          loginAvailable: true,
        }] : []),
      ],
      configured: runtime.hasConfiguredAuth(provider.id),
      status: runtime.getProviderAuthStatus(provider.id),
    })))
  }

  async listModels(): Promise<JsonValue> {
    return safeJson(await (await this.runtime()).getAvailable()) as JsonValue
  }

  async start(providerId: string, authType: "api_key" | "oauth"): Promise<JsonValue> {
    const runtime = await this.runtime()
    const provider = runtime.getProvider(providerId)
    const method = authType === "api_key" ? provider?.auth.apiKey : provider?.auth.oauth
    if (!provider || !method || (authType === "api_key" && !provider.auth.apiKey?.login)) {
      throw Object.assign(new Error(`provider login is unavailable: ${providerId}/${authType}`), {
        code: "INVALID_REQUEST",
      })
    }
    const flowId = randomUUID()
    const flow: AuthFlow = { providerId, controller: new AbortController(), promptIds: new Set() }
    this.flows.set(flowId, flow)
    flow.timer = setTimeout(() => {
      // The SDK login never settled (network hang, no prompt). Abort it so
      // the flow and its prompts are released instead of leaking forever.
      flow.controller.abort()
      this.finish(flowId, { type: "failed", flowId, providerId, message: "provider auth timed out" })
    }, AUTH_FLOW_TIMEOUT_MS)
    flow.timer.unref?.()
    void Promise.resolve().then(() => runtime.login(providerId, authType, {
      signal: flow.controller.signal,
      prompt: prompt => this.prompt(flowId, providerId, prompt),
      notify: event => this.emit({ type: "notification", flowId, providerId, event: safeJson(event) as JsonValue }),
    })).then(
      () => this.finish(flowId, { type: "completed", flowId, providerId }),
      error => this.finish(flowId, flow.controller.signal.aborted
        ? { type: "cancelled", flowId, providerId }
        : { type: "failed", flowId, providerId, message: error instanceof Error ? error.message : String(error) }),
    )
    return { flowId }
  }

  respond(flowId: string, promptId: string, value: string): void {
    const prompt = this.prompts.get(promptId)
    if (!prompt || prompt.flowId !== flowId) {
      throw Object.assign(new Error("provider auth prompt is no longer pending"), { code: "AUTH_REQUIRED" })
    }
    this.prompts.delete(promptId)
    this.flows.get(flowId)?.promptIds.delete(promptId)
    prompt.removeAbort?.()
    prompt.resolve(value)
  }

  cancel(flowId: string): void {
    const flow = this.flows.get(flowId)
    if (!flow) return
    if (flow.timer) clearTimeout(flow.timer)
    flow.controller.abort()
    for (const promptId of flow.promptIds) {
      const prompt = this.prompts.get(promptId)
      this.prompts.delete(promptId)
      prompt?.removeAbort?.()
      prompt?.reject(Object.assign(new Error("provider auth cancelled"), { code: "EXTENSION_UI_CANCELLED" }))
    }
    flow.promptIds.clear()
    this.finish(flowId, { type: "cancelled", flowId, providerId: flow.providerId })
  }

  async logout(providerId: string): Promise<void> {
    await (await this.runtime()).logout(providerId)
  }

  async inspect(): Promise<JsonValue> {
    const runtime = await this.runtime()
    const providers = await this.listProviders()
    const providerList = Array.isArray(providers) ? providers as Array<{ id: string }> : []
    const authChecks = Object.fromEntries(await Promise.all(providerList.map(async provider => [
      provider.id,
      safeJson(await runtime.checkAuth(provider.id)),
    ])))
    const registeredProviderIds = [...runtime.getRegisteredProviderIds()]
    return safeJson({
      providers,
      models: runtime.getModels(),
      availableModels: await runtime.getAvailable(),
      availableSnapshot: runtime.getAvailableSnapshot(),
      credentials: await runtime.listCredentials(),
      registeredProviderIds,
      registeredProviderConfigs: Object.fromEntries(registeredProviderIds.map(providerId => [
        providerId,
        runtime.getRegisteredProviderConfig(providerId),
      ])),
      authChecks,
      error: runtime.getError(),
    }) as JsonValue
  }

  async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
    const runtime = await this.runtime()
    this.runtimeApiKeys.set(providerId, apiKey)
    await runtime.setRuntimeApiKey(providerId, apiKey)
  }

  async removeRuntimeApiKey(providerId: string): Promise<void> {
    this.runtimeApiKeys.delete(providerId)
    await (await this.runtime()).removeRuntimeApiKey(providerId)
  }

  async reloadConfig(): Promise<void> {
    await (await this.runtime()).refresh()
  }

  async refresh(options?: JsonObject): Promise<JsonValue> {
    return safeJson(await (await this.runtime()).refresh(options as never)) as JsonValue
  }

  resetRuntime(): void {
    for (const flowId of [...this.flows.keys()]) this.cancel(flowId)
    this.runtimePromise = undefined
  }

  dispose(): void {
    for (const flowId of [...this.flows.keys()]) this.cancel(flowId)
    this.listeners.clear()
    this.runtimeApiKeys.clear()
  }

  private async runtime(): Promise<ModelRuntime> {
    if (!this.runtimePromise) {
      const factory = this.createRuntime ?? (() => getLoadedSdk().sdk.ModelRuntime.create())
      this.runtimePromise = factory().then(async runtime => {
        for (const [providerId, apiKey] of this.runtimeApiKeys) {
          await runtime.setRuntimeApiKey(providerId, apiKey)
        }
        return runtime
      }).catch(error => {
        this.runtimePromise = undefined
        throw error
      })
    }
    return this.runtimePromise
  }

  private prompt(flowId: string, providerId: string, prompt: {
    type: "text" | "secret" | "select" | "manual_code"
    message: string
    placeholder?: string
    options?: readonly { id: string; label: string; description?: string }[]
    signal?: AbortSignal
  }): Promise<string> {
    if (prompt.signal?.aborted) return Promise.reject(new Error("provider auth prompt aborted"))
    const promptId = randomUUID()
    return new Promise((resolve, reject) => {
      const pending: PendingPrompt = { flowId, resolve, reject }
      if (prompt.signal) {
        const onAbort = () => {
          this.prompts.delete(promptId)
          this.flows.get(flowId)?.promptIds.delete(promptId)
          reject(new Error("provider auth prompt aborted"))
        }
        prompt.signal.addEventListener("abort", onAbort, { once: true })
        pending.removeAbort = () => prompt.signal?.removeEventListener("abort", onAbort)
      }
      this.prompts.set(promptId, pending)
      this.flows.get(flowId)?.promptIds.add(promptId)
      this.emit({
        type: "prompt",
        flowId,
        promptId,
        providerId,
        prompt: {
          type: prompt.type,
          message: prompt.message,
          placeholder: prompt.placeholder ?? null,
          options: prompt.options?.map(option => ({ ...option })) ?? null,
        },
      })
    })
  }

  private finish(flowId: string, event: ProviderAuthEvent): void {
    const flow = this.flows.get(flowId)
    if (!flow) return
    if (flow.timer) clearTimeout(flow.timer)
    // Settle any still-pending prompts so awaiting callers (SDK login) don't
    // hang forever when the flow completes on its own.
    for (const promptId of flow.promptIds) {
      const prompt = this.prompts.get(promptId)
      this.prompts.delete(promptId)
      prompt?.removeAbort?.()
      prompt?.reject(Object.assign(new Error("provider auth flow ended"), { code: "EXTENSION_UI_CANCELLED" }))
    }
    flow.promptIds.clear()
    this.flows.delete(flowId)
    this.emit(event)
  }

  private emit(event: ProviderAuthEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function safeJson(value: unknown): unknown {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/^(api[-_]?key|access|refresh|secret|credential|authorization|proxy-authorization)$/i.test(key)) return "[redacted]"
    if (item instanceof Map) {
      return Object.fromEntries([...item.entries()].map(([mapKey, mapValue]) => [String(mapKey), safeJson(mapValue)]))
    }
    if (item instanceof Error) return { name: item.name, message: item.message }
    if (typeof item === "function" || typeof item === "symbol") return undefined
    if (typeof item === "bigint") return item.toString()
    return item
  }))
}
