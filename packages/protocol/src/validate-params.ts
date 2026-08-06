import type { JsonObject } from "./json.js"

/**
 * 协议 paramsSchema 子集的运行时校验器（type/enum/const/required/properties/
 * additionalProperties/items/anyOf/minimum/maximum）。
 * server 在 HTTP 边缘用它挡掉畸形入参，错误统一 INVALID_REQUEST，
 * 等价于 OC 的 schema-error 中间件。不追求完整 JSON Schema。
 */
export function validateParams(schema: JsonObject | undefined, params: unknown): void {
  if (!schema || Object.keys(schema).length === 0) return
  const problems: string[] = []
  validateValue(schema, params, "params", problems)
  if (problems.length > 0) {
    throw Object.assign(new Error(problems.join("; ")), { code: "INVALID_REQUEST" })
  }
}

function validateValue(schema: JsonObject, value: unknown, path: string, problems: string[]): void {
  if (schema.const !== undefined && value !== schema.const) {
    problems.push(`${path} must be ${JSON.stringify(schema.const)}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    problems.push(`${path} must be one of ${schema.enum.map(item => JSON.stringify(item)).join(", ")}`)
    return
  }
  if (Array.isArray(schema.anyOf)) {
    const branches: string[][] = []
    for (const branch of schema.anyOf) {
      if (branch && typeof branch === "object" && !Array.isArray(branch)) {
        const branchProblems: string[] = []
        validateValue(branch as JsonObject, value, path, branchProblems)
        if (branchProblems.length === 0) return
        branches.push(branchProblems)
      }
    }
    problems.push(branches[0]?.[0] ?? `${path} does not match any allowed shape`)
    return
  }

  switch (schema.type) {
    case "string":
      if (typeof value !== "string") problems.push(`${path} must be a string`)
      return
    case "boolean":
      if (typeof value !== "boolean") problems.push(`${path} must be a boolean`)
      return
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        problems.push(`${path} must be an integer`)
        return
      }
      checkRange(schema, value, path, problems)
      return
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        problems.push(`${path} must be a number`)
        return
      }
      checkRange(schema, value, path, problems)
      return
    case "null":
      if (value !== null) problems.push(`${path} must be null`)
      return
    case "array": {
      if (!Array.isArray(value)) {
        problems.push(`${path} must be an array`)
        return
      }
      const items = schema.items
      if (items && typeof items === "object" && !Array.isArray(items)) {
        value.forEach((item, index) => validateValue(items as JsonObject, item, `${path}[${index}]`, problems))
      }
      return
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        problems.push(`${path} must be an object`)
        return
      }
      const record = value as Record<string, unknown>
      const properties = (schema.properties ?? {}) as Record<string, JsonObject>
      for (const field of (schema.required as string[] | undefined) ?? []) {
        if (record[field] === undefined) problems.push(`${path}.${field} is required`)
      }
      for (const [field, fieldSchema] of Object.entries(properties)) {
        if (record[field] !== undefined) validateValue(fieldSchema, record[field], `${path}.${field}`, problems)
      }
      if (schema.additionalProperties === false) {
        for (const field of Object.keys(record)) {
          if (!(field in properties)) problems.push(`${path}.${field} is not a declared parameter`)
        }
      }
      return
    }
    default:
      // 未声明 type（ANY_JSON）或不认识的类型：放行
      return
  }
}

function checkRange(schema: JsonObject, value: number, path: string, problems: string[]): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    problems.push(`${path} must be >= ${schema.minimum}`)
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    problems.push(`${path} must be <= ${schema.maximum}`)
  }
}
