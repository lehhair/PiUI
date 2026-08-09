import type { ImageInput, JsonObject, JsonValue } from "@piui/protocol"
import { isJsonObject } from "@piui/protocol"

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST" })
}

export function reqString(params: JsonObject, key: string): string {
  const value = params[key]
  if (typeof value !== "string" || !value) throw invalid(`params.${key} must be a non-empty string`)
  return value
}

export function reqStringAllowEmpty(params: JsonObject, key: string): string {
  const value = params[key]
  if (typeof value !== "string") throw invalid(`params.${key} must be a string`)
  return value
}

export function optString(params: JsonObject, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw invalid(`params.${key} must be a string`)
  return value
}

export function reqBoolean(params: JsonObject, key: string): boolean {
  const value = params[key]
  if (typeof value !== "boolean") throw invalid(`params.${key} must be a boolean`)
  return value
}

export function optBoolean(params: JsonObject, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw invalid(`params.${key} must be a boolean`)
  return value
}

export function reqNumber(params: JsonObject, key: string): number {
  const value = params[key]
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`params.${key} must be a finite number`)
  return value
}

export function optNumber(params: JsonObject, key: string): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`params.${key} must be a finite number`)
  return value
}

/** Optional positive integer (>= 1); matches schemas declaring minimum: 1. */
export function optPositiveInteger(params: JsonObject, key: string): number | undefined {
  const value = optNumber(params, key)
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1) throw invalid(`params.${key} must be an integer >= 1`)
  return value
}

export function reqNonNegativeInteger(params: JsonObject, key: string): number {
  const value = reqNumber(params, key)
  if (!Number.isInteger(value) || value < 0) throw invalid(`params.${key} must be an integer >= 0`)
  return value
}

/** Required positive integer (>= 1); matches schemas declaring minimum: 1. */
export function reqPositiveInteger(params: JsonObject, key: string): number {
  const value = reqNumber(params, key)
  if (!Number.isInteger(value) || value < 1) throw invalid(`params.${key} must be an integer >= 1`)
  return value
}

export function optStringArray(params: JsonObject, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw invalid(`params.${key} must be an array of strings`)
  }
  return value as string[]
}

export function optImages(params: JsonObject, key = "images"): ImageInput[] | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw invalid(`params.${key} must be an array`)
  return value.map((item, index) => {
    if (!isJsonObject(item) || item.type !== "image" ||
      typeof item.data !== "string" || typeof item.mimeType !== "string") {
      throw invalid(`params.${key}[${index}] must be an ImageInput`)
    }
    return { type: "image" as const, data: item.data, mimeType: item.mimeType }
  })
}

export function optObject(params: JsonObject, key: string): JsonObject | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (!isJsonObject(value)) throw invalid(`params.${key} must be an object`)
  return value
}

export function optValue(params: JsonObject, key: string): JsonValue | undefined {
  const value = params[key]
  return value === undefined ? undefined : value
}

export function optEnum<T extends string>(params: JsonObject, key: string, values: readonly T[]): T | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw invalid(`params.${key} must be one of ${values.join(", ")}`)
  }
  return value as T
}
