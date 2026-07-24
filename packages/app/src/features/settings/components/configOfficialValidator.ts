import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020'
import { isTauri } from '../../../utils/tauri'

const CONFIG_SCHEMA_URL = 'https://opencode.ai/config.json'
const MODEL_SCHEMA_ID = 'https://models.dev/model-schema.json'

export type OfficialConfigValidationError = {
  path: string
  segments?: string[]
  message: string
}

export type OfficialConfigValidationResult = {
  errors: OfficialConfigValidationError[]
  unavailable?: string
}

let validatorPromise: Promise<ValidateFunction> | undefined
let schemaFetch: typeof globalThis.fetch | undefined
let schemaFetchPromise: Promise<typeof globalThis.fetch> | undefined

export async function validateAgainstOfficialConfigSchema(config: unknown): Promise<OfficialConfigValidationResult> {
  try {
    const validate = await getOfficialConfigValidator()
    const valid = validate(config)
    if (valid) return { errors: [] }
    return { errors: normalizeAjvErrors(validate.errors ?? []) }
  } catch (error) {
    return { errors: [], unavailable: error instanceof Error ? error.message : String(error) }
  }
}

async function getOfficialConfigValidator() {
  validatorPromise ??= loadOfficialConfigValidator().catch(error => {
    validatorPromise = undefined
    throw error
  })
  return validatorPromise
}

async function loadOfficialConfigValidator() {
  const schema = await fetchOfficialConfigSchema()
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  ajv.addSchema({
    $id: MODEL_SCHEMA_ID,
    $defs: {
      Model: { type: 'string' },
    },
  })
  return ajv.compile(schema)
}

async function fetchOfficialConfigSchema() {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 5000)
  try {
    const fetchSchema = await getSchemaFetch()
    const response = await fetchSchema(CONFIG_SCHEMA_URL, { signal: controller.signal })
    if (!response.ok) throw new Error(`Failed to load official config schema: ${response.status}`)
    return await response.json()
  } finally {
    window.clearTimeout(timeout)
  }
}

async function getSchemaFetch(): Promise<typeof globalThis.fetch> {
  if (!isTauri()) return globalThis.fetch
  if (schemaFetch) return schemaFetch
  schemaFetchPromise ??= import('@tauri-apps/plugin-http')
    .then(mod => {
      schemaFetch = mod.fetch as unknown as typeof globalThis.fetch
      return schemaFetch
    })
    .catch(error => {
      schemaFetchPromise = undefined
      throw error
    })
  return schemaFetchPromise
}

function normalizeAjvErrors(errors: ErrorObject[]): OfficialConfigValidationError[] {
  const normalized = errors.map(error => ({ ...errorLocation(error), message: error.message ?? 'invalid value' }))
  const seen = new Set<string>()
  return normalized.filter(error => {
    const key = `${error.path}:${error.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function errorLocation(error: ErrorObject) {
  if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') {
    return joinLocation(error.instancePath, error.params.missingProperty)
  }
  if (error.keyword === 'additionalProperties' && typeof error.params.additionalProperty === 'string') {
    return joinLocation(error.instancePath, error.params.additionalProperty)
  }
  const segments = pointerToSegments(error.instancePath)
  return { path: segments.length ? segments.join('.') : '$', segments }
}

function joinLocation(pointer: string, key: string) {
  const segments = [...pointerToSegments(pointer), key]
  return { path: segments.join('.'), segments }
}

function pointerToSegments(pointer: string) {
  if (!pointer) return []
  return pointer
    .split('/')
    .slice(1)
    .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
}
