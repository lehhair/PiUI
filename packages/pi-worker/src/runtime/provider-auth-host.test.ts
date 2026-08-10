import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { ProviderAuthEvent } from "./provider-auth-host.js"
import { ProviderAuthHost } from "./provider-auth-host.ts"

describe("ProviderAuthHost", () => {
  it("lists models from the credential-aware runtime", async () => {
    const model = { id: "fixture-model", provider: "fixture" }
    const runtime = {
      getAvailable: async () => [model],
    } as unknown as ModelRuntime

    const models = await new ProviderAuthHost(async () => runtime).listModels()
    assert.deepEqual(models, [model])
  })

  it("keeps native model fields including maxTokens during inspection", async () => {
    const model = {
      id: "fixture-model",
      name: "Fixture",
      api: "fixture-api",
      provider: "fixture",
      baseUrl: "https://example.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      contextWindow: 4096,
      maxTokens: 512,
      compat: { future: true },
    }
    const provider = { id: "fixture", name: "Fixture", auth: {} }
    const runtime = {
      getProviders: () => [provider],
      getProvider: () => provider,
      hasConfiguredAuth: () => true,
      getProviderAuthStatus: () => ({ configured: true }),
      checkAuth: async () => ({ configured: true }),
      getRegisteredProviderIds: () => ["fixture"],
      getRegisteredProviderConfig: () => ({ apiKey: "secret", maxTokens: 99 }),
      getModels: () => [model],
      getAvailable: async () => [model],
      getAvailableSnapshot: () => [model],
      listCredentials: async () => [{ providerId: "fixture", type: "api_key" }],
      getError: () => undefined,
    } as unknown as ModelRuntime

    const snapshot = await new ProviderAuthHost(async () => runtime).inspect()
    const registered = snapshot.registeredProviderConfigs.fixture as Record<string, unknown>
    assert.deepEqual(snapshot.models[0], model)
    assert.equal(snapshot.availableModels[0]?.maxTokens, 512)
    assert.equal(registered.apiKey, "[redacted]")
    assert.equal(registered.maxTokens, 99)
  })

  it("preserves refresh errors and recreates the runtime after replacement", async () => {
    let creates = 0
    const host = new ProviderAuthHost(async () => {
      creates += 1
      return {
        refresh: async () => ({
          refreshed: [],
          errors: new Map([["fixture", new Error(`refresh failed ${creates}`)]]),
        }),
      } as unknown as ModelRuntime
    })

    const first = await host.refresh() as { errors: Record<string, { message: string }> }
    assert.equal(first.errors.fixture.message, "refresh failed 1")
    host.resetRuntime()
    const second = await host.refresh() as { errors: Record<string, { message: string }> }
    assert.equal(second.errors.fixture.message, "refresh failed 2")
    assert.equal(creates, 2)
  })

  it("reapplies temporary API keys when the runtime is replaced", async () => {
    const applied: string[] = []
    let creates = 0
    const host = new ProviderAuthHost(async () => {
      creates += 1
      return {
        setRuntimeApiKey: async (providerId: string, apiKey: string) => applied.push(`${creates}:${providerId}:${apiKey}`),
        getAvailable: async () => [],
      } as unknown as ModelRuntime
    })

    await host.setRuntimeApiKey("opencode", "public")
    host.resetRuntime()
    await host.listModels()

    assert.deepEqual(applied, ["1:opencode:public", "2:opencode:public"])
  })

  it("bridges secret prompts without exposing the submitted value in events", async () => {
    let storedValue = ""
    let loggedOut = ""
    const provider = {
      id: "fixture",
      name: "Fixture",
      auth: { apiKey: { name: "Fixture key", login: async () => ({}) } },
    }
    const runtime = {
      getProviders: () => [provider],
      getProvider: () => provider,
      hasConfiguredAuth: () => false,
      getProviderAuthStatus: () => ({ configured: false }),
      login: async (_providerId: string, _type: string, interaction: {
        prompt(prompt: { type: "secret"; message: string }): Promise<string>
      }) => {
        storedValue = await interaction.prompt({ type: "secret", message: "API key" })
      },
      logout: async (providerId: string) => { loggedOut = providerId },
    } as unknown as ModelRuntime
    const host = new ProviderAuthHost(async () => runtime)
    const events: ProviderAuthEvent[] = []
    let completed!: () => void
    const completion = new Promise<void>(resolve => { completed = resolve })
    host.onEvent(event => {
      events.push(event)
      if (event.type === "completed") completed()
    })

    const { flowId } = await host.start("fixture", "api_key") as { flowId: string }
    await new Promise(resolve => setImmediate(resolve))
    const prompt = events.find((event): event is Extract<ProviderAuthEvent, { type: "prompt" }> =>
      event.type === "prompt")
    assert.ok(prompt)
    assert.equal(prompt.prompt.type, "secret")
    host.respond(flowId, prompt.promptId, "top-secret")
    await completion
    assert.equal(storedValue, "top-secret")
    assert.equal(JSON.stringify(events).includes("top-secret"), false)

    await host.logout("fixture")
    assert.equal(loggedOut, "fixture")
  })

  it("lists in-flight auth flows with pending prompts (refresh recovery)", async () => {
    let promptHandler: ((prompt: { type: "text"; message: string }) => Promise<string>) | undefined
    const provider = {
      id: "fixture",
      name: "Fixture",
      auth: { apiKey: { name: "Fixture key", login: async () => ({}) } },
    }
    const runtime = {
      getProviders: () => [provider],
      getProvider: () => provider,
      hasConfiguredAuth: () => false,
      getProviderAuthStatus: () => ({ configured: false }),
      login: async (_providerId: string, _type: string, interaction: {
        prompt(prompt: { type: "text"; message: string }): Promise<string>
      }) => {
        promptHandler = interaction.prompt
        await new Promise(() => undefined) // 模拟 SDK login 阻塞等应答
      },
    } as unknown as ModelRuntime
    const host = new ProviderAuthHost(async () => runtime)

    await host.start("fixture", "api_key")
    await new Promise(resolve => setImmediate(resolve))
    // 不 await：prompt 会阻塞到 respond 才解析
    void promptHandler?.({ type: "text", message: "Enter token" })
    await new Promise(resolve => setImmediate(resolve))

    const flows = await host.listActiveFlows() as Array<{
      flowId: string
      providerId: string
      authType: string
      prompts: Array<{ promptId: string; type: string; message: string }>
    }>
    assert.equal(flows.length, 1)
    assert.equal(flows[0].providerId, "fixture")
    assert.equal(flows[0].authType, "api_key")
    assert.deepEqual(flows[0].prompts.map(prompt => [prompt.type, prompt.message]), [["text", "Enter token"]])

    // 应答后 prompt 从快照消失，flow 仍在（SDK login 可能还有后续交互）
    host.respond(flows[0].flowId, flows[0].prompts[0].promptId, "answer")
    const after = await host.listActiveFlows() as Array<{ prompts: unknown[] }>
    assert.equal(after[0].prompts.length, 0)
    host.dispose()
  })
})
