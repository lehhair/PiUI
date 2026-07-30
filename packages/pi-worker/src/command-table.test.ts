import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { COMMAND_HANDLERS, getCommandCapability, listCommandCapabilities, listCommandTypes } from "./command-table.ts"

describe("Pi capability registry", () => {
  it("is the source of truth for command handlers", () => {
    const global = listCommandCapabilities("global")
    const session = listCommandCapabilities("session")
    const names = [...global, ...session].map(capability => capability.name)

    assert.deepEqual(new Set(names).size, names.length)
    assert.deepEqual(new Set(Object.keys(COMMAND_HANDLERS)), new Set(names))
    assert.deepEqual(new Set(listCommandTypes()), new Set(names))
  })

  it("describes command parameters and execution semantics precisely enough for clients", () => {
    const prompt = getCommandCapability("prompt")
    assert.equal(prompt?.scope, "session")
    assert.equal(prompt.queue, "serialized")
    assert.equal(prompt.streaming, true)
    assert.equal(prompt.cancellable, true)
    assert.deepEqual(prompt.paramsSchema?.required, ["text"])
    assert.deepEqual(prompt.paramsSchema?.properties, {
      text: { type: "string" },
      images: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "data", "mimeType"],
          properties: {
            type: { const: "image" },
            data: { type: "string" },
            mimeType: { type: "string" },
          },
        },
      },
      expandPromptTemplates: { type: "boolean" },
      streamingBehavior: { type: "string", enum: ["steer", "followUp"] },
    })

    const branch = getCommandCapability("branch.get")
    assert.equal(branch?.queue, "immediate")
    assert.equal(branch.idempotent, true)
    assert.deepEqual(branch.paramsSchema?.properties?.cursor, { anyOf: [{ type: "string" }, { type: "null" }] })

    const invokeTool = getCommandCapability("invokeTool")
    assert.equal(invokeTool?.source, "pi-extension")
    assert.deepEqual(invokeTool.paramsSchema?.required, ["name"])

    const fork = getCommandCapability("fork")
    assert.equal(fork?.replacement, true)
  })
})
