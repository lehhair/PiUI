import assert from "node:assert/strict"
import { test } from "node:test"
import { validateParams } from "./validate-params.ts"
import { HOST_COMMAND_SPECS, PI_COMMAND_SPECS, objectSchema } from "./index.ts"

function invalid(schema: Parameters<typeof validateParams>[0], params: unknown): string {
  try {
    validateParams(schema, params)
  } catch (error) {
    assert.equal((error as { code?: string }).code, "INVALID_REQUEST")
    return (error as Error).message
  }
  assert.fail("expected INVALID_REQUEST")
}

test("accepts values that satisfy the schema", () => {
  validateParams(undefined, { anything: true })
  validateParams({}, { anything: true })
  validateParams(objectSchema({ cwd: { type: "string" } }, ["cwd"]), { cwd: "/tmp" })
  validateParams(objectSchema({ mode: { enum: ["git", "branch"] } }), { mode: "git" })
  validateParams(objectSchema({ cursor: { anyOf: [{ type: "string" }, { type: "null" }] } }), { cursor: null })
})

test("rejects missing required fields and undeclared parameters", () => {
  assert.match(invalid(objectSchema({ cwd: { type: "string" } }, ["cwd"]), {}), /params\.cwd is required/)
  assert.match(invalid(objectSchema({ cwd: { type: "string" } }), { cwd: "/tmp", extra: 1 }), /params\.extra is not a declared parameter/)
})

test("rejects wrong primitive types, enums, and ranges", () => {
  assert.match(invalid(objectSchema({ cwd: { type: "string" } }, ["cwd"]), { cwd: 1 }), /params\.cwd must be a string/)
  assert.match(invalid(objectSchema({ flag: { type: "boolean" } }), { flag: "yes" }), /params\.flag must be a boolean/)
  assert.match(invalid(objectSchema({ mode: { enum: ["git", "branch"] } }), { mode: "nope" }), /params\.mode must be one of/)
  assert.match(invalid(objectSchema({ limit: { type: "integer", minimum: 1 } }), { limit: 0 }), /params\.limit must be >= 1/)
  assert.match(invalid(objectSchema({ limit: { type: "integer" } }), { limit: 1.5 }), /params\.limit must be an integer/)
})

test("validates nested objects and arrays", () => {
  const schema = objectSchema({ patterns: { type: "array", items: { type: "string" } } }, ["patterns"])
  validateParams(schema, { patterns: ["a", "b"] })
  assert.match(invalid(schema, { patterns: ["a", 2] }), /params\.patterns\[1\] must be a string/)
})

test("declared command specs accept their documented shapes", () => {
  const spec = (name: string) => PI_COMMAND_SPECS.find(item => item.name === name)?.paramsSchema
  validateParams(spec("setModel"), { provider: "openai", modelId: "gpt-5" })
  validateParams(spec("branch.get"), { cursor: null, limit: 50 })
  validateParams(spec("fork"), { entryId: "e1" })
  validateParams(spec("fork"), { entryId: "e1", position: "before" })
  const hostSpec = (name: string) => HOST_COMMAND_SPECS.find(item => item.name === name)?.paramsSchema
  validateParams(hostSpec("git.diff"), { workspacePath: "/tmp" })
  validateParams(hostSpec("terminals.create"), { workspacePath: "/tmp", rows: 24, cols: 80 })
  assert.match(invalid(hostSpec("terminals.create"), { workspacePath: "/tmp", rows: 0 }), /params\.rows must be >= 1/)
})
