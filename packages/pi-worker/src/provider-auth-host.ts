import { randomUUID } from "node:crypto"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { PiModelRuntimeSnapshotV1, ProviderAuthEventV1, ProviderAuthInfoV1 } from "@piui/protocol"

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
}

export class ProviderAuthHost {
  private readonly listeners = new Set<(event: ProviderAuthEventV1) => void>()
  private readonly flows = new Map<string, AuthFlow>()
  private readonly prompts = new Map<string, PendingPrompt>()
  private runtimePromise?: Promise<ModelRuntime>

  constructor(private readonly createRuntime: () => Promise<ModelRuntime> = () => ModelRuntime.create()) {}

  onEvent(listener: (event: ProviderAuthEventV1) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async listProviders(): Promise<ProviderAuthInfoV1[]> {
    const runtime = await this.runtime()
    return runtime.getProviders().map(provider => ({
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
    }))
  }

  async start(providerId: string, authType: "api_key" | "oauth"): Promise<string> {
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
    void runtime.login(providerId, authType, {
      signal: flow.controller.signal,
      prompt: prompt => this.prompt(flowId, providerId, prompt),
      notify: event => this.emit({ type: "notification", flowId, providerId, event }),
    }).then(
      () => this.finish(flowId, { type: "completed", flowId, providerId }),
      error => this.finish(flowId, flow.controller.signal.aborted
        ? { type: "cancelled", flowId, providerId }
        : { type: "failed", flowId, providerId, message: error instanceof Error ? error.message : String(error) }),
    )
    return flowId
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
    flow.controller.abort()
    for (const promptId of flow.promptIds) {
      const prompt = this.prompts.get(promptId)
      this.prompts.delete(promptId)
      prompt?.removeAbort?.()
      prompt?.reject(Object.assign(new Error("provider auth cancelled"), { code: "EXTENSION_UI_CANCELLED" }))
    }
    flow.promptIds.clear()
  }

  async logout(providerId: string): Promise<void> {
    await (await this.runtime()).logout(providerId)
  }

  async inspect(): Promise<PiModelRuntimeSnapshotV1> {
    const runtime = await this.runtime()
    const providers = await this.listProviders()
    const authChecks = Object.fromEntries(await Promise.all(providers.map(async provider => [
      provider.id,
      safeJson(await runtime.checkAuth(provider.id)),
    ])))
    const registeredProviderIds = [...runtime.getRegisteredProviderIds()]
    return {
      providers,
      models: [...jsonClone(runtime.getModels())],
      availableModels: [...jsonClone(await runtime.getAvailable())],
      availableSnapshot: [...jsonClone(runtime.getAvailableSnapshot())],
      credentials: [...jsonClone(await runtime.listCredentials())],
      registeredProviderIds,
      registeredProviderConfigs: Object.fromEntries(registeredProviderIds.map(providerId => [
        providerId,
        safeJson(runtime.getRegisteredProviderConfig(providerId)),
      ])),
      authChecks,
      error: runtime.getError(),
    }
  }

  async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
    await (await this.runtime()).setRuntimeApiKey(providerId, apiKey)
  }

  async removeRuntimeApiKey(providerId: string): Promise<void> {
    await (await this.runtime()).removeRuntimeApiKey(providerId)
  }

  async reloadConfig(): Promise<void> {
    await (await this.runtime()).reloadConfig()
  }

  async refresh(options?: Record<string, unknown>): Promise<unknown> {
    return safeJson(await (await this.runtime()).refresh(options as never))
  }

  resetRuntime(): void {
    for (const flowId of [...this.flows.keys()]) this.cancel(flowId)
    this.runtimePromise = undefined
  }

  dispose(): void {
    for (const flowId of this.flows.keys()) this.cancel(flowId)
    this.listeners.clear()
  }

  private async runtime(): Promise<ModelRuntime> {
    // A failed creation must not be cached, otherwise one transient error
    // would break every later auth operation until a session replacement.
    return this.runtimePromise ??= this.createRuntime().catch(error => {
      this.runtimePromise = undefined
      throw error
    })
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
          placeholder: prompt.placeholder,
          options: prompt.options?.map(option => ({ ...option })),
        },
      })
    })
  }

  private finish(flowId: string, event: ProviderAuthEventV1): void {
    const flow = this.flows.get(flowId)
    if (!flow) return
    for (const promptId of flow.promptIds) {
      const prompt = this.prompts.get(promptId)
      this.prompts.delete(promptId)
      prompt?.removeAbort?.()
    }
    this.flows.delete(flowId)
    this.emit(event)
  }

  private emit(event: ProviderAuthEventV1): void {
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

function jsonClone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item instanceof Map) return Object.fromEntries(item)
    if (item instanceof Error) return { name: item.name, message: item.message }
    if (typeof item === "function" || typeof item === "symbol") return undefined
    if (typeof item === "bigint") return item.toString()
    return item
  })) as T
}
