export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue | undefined }

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return undefined
  }
}

export function requireJsonValue(value: unknown, code = "NATIVE_DATA_NOT_JSON"): JsonValue {
  const json = toJsonValue(value)
  if (json === undefined) {
    throw Object.assign(new Error("value is not JSON serializable"), { code })
  }
  return json
}

export function requireJsonObject(value: unknown, code = "NATIVE_DATA_NOT_JSON"): JsonObject {
  const json = requireJsonValue(value, code)
  if (!isJsonObject(json)) {
    throw Object.assign(new Error("value is not a JSON object"), { code })
  }
  return json
}

export function requireJsonArray(value: unknown, code = "NATIVE_DATA_NOT_JSON"): JsonValue[] {
  const json = requireJsonValue(value, code)
  if (!Array.isArray(json)) {
    throw Object.assign(new Error("value is not a JSON array"), { code })
  }
  return json
}
