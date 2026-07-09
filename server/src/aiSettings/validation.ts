/**
 * Input validation for the AI settings update endpoint.
 *
 * All validators return an array of human-readable error strings — an empty
 * array signals a valid patch. This mirrors the pattern already used by the
 * task validation module so route handlers have a single, consistent shape.
 *
 * Security notes
 * ──────────────
 * - We never log the raw API key content. Only its length is inspected.
 * - Numeric ranges are bounded to keep pathological requests (e.g.
 *   `maxTokens: 1e18`) from bloating persisted state.
 */

import { VALID_AGENTS } from '../tasks/validation.js'
import type { AgentName } from '../tasks/types.js'
import { VALID_AI_PROVIDERS, type AiProvider, type UpdateAiSettingsInput } from './types.js'

/** Bounds constants — exported so tests and clients can reference them. */
export const AI_MODEL_MAX_LENGTH = 200
export const AI_API_KEY_MAX_LENGTH = 4_096
export const AI_TEMPERATURE_MIN = 0
export const AI_TEMPERATURE_MAX = 2
export const AI_MAX_TOKENS_MIN = 1
export const AI_MAX_TOKENS_MAX = 200_000

/**
 * Ensure the raw body is a JSON object. Guards against arrays and primitives
 * which JSON.parse happily accepts but this endpoint does not.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a single-optional-field, nullable enum. Returns an error string
 * for use in the aggregate list, or null when the field is either omitted or
 * valid.
 */
function validateEnumField<T extends string>(
  fieldName: string,
  raw: unknown,
  valid: readonly T[],
): string | null {
  if (raw === undefined) return null
  if (raw === null) return null // explicit clear
  if (typeof raw !== 'string' || !(valid as readonly string[]).includes(raw)) {
    return `${fieldName}: must be one of ${valid.join(', ')} (or null to clear)`
  }
  return null
}

function validateApiKey(raw: unknown): string | null {
  if (raw === undefined) return null
  if (raw === null) return null // explicit clear
  if (typeof raw !== 'string') {
    return 'apiKey: must be a string, null (to clear), or omitted'
  }
  if (raw.length === 0) {
    return 'apiKey: must be a non-empty string (send null to clear)'
  }
  if (raw.length > AI_API_KEY_MAX_LENGTH) {
    return `apiKey: must not exceed ${AI_API_KEY_MAX_LENGTH} characters`
  }
  return null
}

function validateModel(raw: unknown): string | null {
  if (raw === undefined) return null
  if (raw === null) return null
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return 'model: must be a non-empty string (send null to clear)'
  }
  if (raw.length > AI_MODEL_MAX_LENGTH) {
    return `model: must not exceed ${AI_MODEL_MAX_LENGTH} characters`
  }
  return null
}

function validateTemperature(raw: unknown): string | null {
  if (raw === undefined) return null
  if (raw === null) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 'temperature: must be a finite number (send null to clear)'
  }
  if (raw < AI_TEMPERATURE_MIN || raw > AI_TEMPERATURE_MAX) {
    return `temperature: must be between ${AI_TEMPERATURE_MIN} and ${AI_TEMPERATURE_MAX}`
  }
  return null
}

function validateMaxTokens(raw: unknown): string | null {
  if (raw === undefined) return null
  if (raw === null) return null
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return 'maxTokens: must be an integer (send null to clear)'
  }
  if (raw < AI_MAX_TOKENS_MIN || raw > AI_MAX_TOKENS_MAX) {
    return `maxTokens: must be between ${AI_MAX_TOKENS_MIN} and ${AI_MAX_TOKENS_MAX}`
  }
  return null
}

/**
 * Validate a PUT body. Returns an array of human-readable error messages.
 * Empty array => valid. Rejects unexpected top-level fields so the API surface
 * stays explicit: a client typo like `apikey` (lowercase) results in a
 * validation error rather than silently no-op'ing.
 */
export function validateUpdateAiSettings(body: unknown): string[] {
  if (!isPlainObject(body)) {
    return ['request body must be a JSON object']
  }
  const errors: string[] = []

  const providerErr = validateEnumField<AiProvider>('provider', body.provider, VALID_AI_PROVIDERS)
  if (providerErr) errors.push(providerErr)

  const defaultAgentErr = validateEnumField<AgentName>('defaultAgent', body.defaultAgent, VALID_AGENTS)
  if (defaultAgentErr) errors.push(defaultAgentErr)

  const apiKeyErr = validateApiKey(body.apiKey)
  if (apiKeyErr) errors.push(apiKeyErr)

  const modelErr = validateModel(body.model)
  if (modelErr) errors.push(modelErr)

  const temperatureErr = validateTemperature(body.temperature)
  if (temperatureErr) errors.push(temperatureErr)

  const maxTokensErr = validateMaxTokens(body.maxTokens)
  if (maxTokensErr) errors.push(maxTokensErr)

  // Reject unknown top-level keys so client mistakes surface as errors.
  const allowed = new Set<keyof UpdateAiSettingsInput>([
    'provider',
    'apiKey',
    'defaultAgent',
    'model',
    'temperature',
    'maxTokens',
  ])
  for (const key of Object.keys(body)) {
    if (!allowed.has(key as keyof UpdateAiSettingsInput)) {
      errors.push(`unknown field: ${key}`)
    }
  }

  return errors
}
