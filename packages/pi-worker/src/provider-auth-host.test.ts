import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { ProviderAuthEventV1 } from "@piui/protocol"
import { ProviderAuthHost } from "./provider-auth-host.ts"

describe("ProviderAuthHost", () => {
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
    const events: ProviderAuthEventV1[] = []
    let completed!: () => void
    const completion = new Promise<void>(resolve => { completed = resolve })
    host.onEvent(event => {
      events.push(event)
      if (event.type === "completed") completed()
    })

    const flowId = await host.start("fixture", "api_key")
    await new Promise(resolve => setImmediate(resolve))
    const prompt = events.find((event): event is Extract<ProviderAuthEventV1, { type: "prompt" }> =>
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
})
