import type { JsonObject } from "./json.js"

/**
 * 极简 JSON Schema 构造器——协议的 paramsSchema 只用这个子集：
 * type/enum/const/required/properties/items/anyOf/minimum/additionalProperties。
 * worker 和 server 的入参校验（P5）也只实现这个子集。
 */
export const STRING: JsonObject = { type: "string" }
export const BOOLEAN: JsonObject = { type: "boolean" }
export const NUMBER: JsonObject = { type: "number" }
export const NULL: JsonObject = { type: "null" }
export const ANY_JSON: JsonObject = {}
export const STRING_ARRAY: JsonObject = { type: "array", items: STRING }

export function objectSchema(
  properties: Record<string, JsonObject>,
  required: string[] = [],
  additionalProperties = false,
): JsonObject {
  return { type: "object", additionalProperties, required, properties }
}

export function nullable(schema: JsonObject): JsonObject {
  return { anyOf: [schema, NULL] }
}

export const EMPTY_PARAMS = objectSchema({})

export const IMAGE_INPUT: JsonObject = objectSchema(
  { type: { const: "image" }, data: STRING, mimeType: STRING },
  ["type", "data", "mimeType"],
)
export const IMAGES: JsonObject = { type: "array", items: IMAGE_INPUT }

export function pageParams(): JsonObject {
  return objectSchema({
    cursor: nullable(STRING),
    limit: { type: "integer", minimum: 1 },
    maxBytes: { type: "integer", minimum: 1 },
  })
}
