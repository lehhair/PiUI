import assert from "node:assert/strict"
import { test } from "node:test"
import { HOST_COMMAND_SPECS, PI_COMMAND_SPECS } from "./index.ts"
import type { JsonObject } from "./json.ts"

function assertSchemaSane(name: string, schema: JsonObject | undefined): void {
  if (!schema) return
  if (schema.type !== "object") return
  const properties = schema.properties as Record<string, unknown> | undefined
  const required = (schema.required as string[] | undefined) ?? []
  if (required.length > 0) {
    assert.ok(properties, `${name}: required fields need a properties map`)
    for (const field of required) {
      assert.ok(field in (properties ?? {}), `${name}: required field "${field}" missing from properties`)
    }
  }
}

test("command spec names are unique", () => {
  const pi = PI_COMMAND_SPECS.map(spec => spec.name)
  assert.equal(new Set(pi).size, pi.length, "duplicate Pi command spec names")
  const host = HOST_COMMAND_SPECS.map(spec => spec.name)
  assert.equal(new Set(host).size, host.length, "duplicate host command spec names")
})

test("command spec schemas are internally consistent", () => {
  for (const spec of [...PI_COMMAND_SPECS, ...HOST_COMMAND_SPECS]) {
    assertSchemaSane(spec.name, spec.paramsSchema)
  }
})

test("serialized pi commands are not marked idempotent", () => {
  for (const spec of [...PI_COMMAND_SPECS, ...HOST_COMMAND_SPECS]) {
    if (spec.queue === "serialized") {
      assert.ok(!spec.idempotent, `${spec.name}: serialized commands must not be idempotent`)
    }
  }
})
