/**
 * Unit tests for validateUpdateAiSettings.
 *
 * Exercises the valid cases (partial updates, explicit clears), the reject
 * cases (unknown fields, malformed types, out-of-range numerics, oversized
 * strings), and the specific type/`null`/omitted semantics for each field.
 */

import { describe, expect, it } from 'vitest'
import {
  AI_API_KEY_MAX_LENGTH,
  AI_MAX_TOKENS_MAX,
  AI_MAX_TOKENS_MIN,
  AI_MODEL_MAX_LENGTH,
  AI_TEMPERATURE_MAX,
  AI_TEMPERATURE_MIN,
  validateUpdateAiSettings,
} from '../server/src/aiSettings/validation.js'

describe('validateUpdateAiSettings — top-level shape', () => {
  it('rejects non-object bodies', () => {
    expect(validateUpdateAiSettings(null)).toEqual(['request body must be a JSON object'])
    expect(validateUpdateAiSettings('a string')).toEqual(['request body must be a JSON object'])
    expect(validateUpdateAiSettings([])).toEqual(['request body must be a JSON object'])
  })

  it('accepts an empty object (no-op update)', () => {
    expect(validateUpdateAiSettings({})).toEqual([])
  })

  it('rejects unknown top-level keys', () => {
    const errs = validateUpdateAiSettings({ apikey: 'sk-typo' })
    expect(errs.join(' ')).toContain('unknown field: apikey')
  })
})

describe('validateUpdateAiSettings — provider', () => {
  it('accepts each valid provider', () => {
    expect(validateUpdateAiSettings({ provider: 'opencode' })).toEqual([])
    expect(validateUpdateAiSettings({ provider: 'claude-code' })).toEqual([])
    expect(validateUpdateAiSettings({ provider: 'omnimancer' })).toEqual([])
  })

  it('accepts null as an explicit clear', () => {
    expect(validateUpdateAiSettings({ provider: null })).toEqual([])
  })

  it('rejects unknown values', () => {
    expect(validateUpdateAiSettings({ provider: 'gpt' })).not.toEqual([])
  })

  it('rejects non-string types', () => {
    expect(validateUpdateAiSettings({ provider: 42 })).not.toEqual([])
  })
})

describe('validateUpdateAiSettings — defaultAgent', () => {
  it('accepts each valid agent', () => {
    expect(validateUpdateAiSettings({ defaultAgent: 'opencode' })).toEqual([])
    expect(validateUpdateAiSettings({ defaultAgent: 'claude-code' })).toEqual([])
    expect(validateUpdateAiSettings({ defaultAgent: 'omnimancer' })).toEqual([])
  })

  it('accepts null as an explicit clear', () => {
    expect(validateUpdateAiSettings({ defaultAgent: null })).toEqual([])
  })

  it('rejects unknown values', () => {
    expect(validateUpdateAiSettings({ defaultAgent: 'ghost-agent' })).not.toEqual([])
  })
})

describe('validateUpdateAiSettings — apiKey', () => {
  it('accepts a non-empty string', () => {
    expect(validateUpdateAiSettings({ apiKey: 'sk-live-123' })).toEqual([])
  })

  it('accepts null as an explicit clear', () => {
    expect(validateUpdateAiSettings({ apiKey: null })).toEqual([])
  })

  it('rejects an empty string (send null to clear instead)', () => {
    const errs = validateUpdateAiSettings({ apiKey: '' })
    expect(errs.join(' ')).toContain('apiKey')
  })

  it('rejects non-string types (non-null)', () => {
    expect(validateUpdateAiSettings({ apiKey: 42 })).not.toEqual([])
    expect(validateUpdateAiSettings({ apiKey: {} })).not.toEqual([])
  })

  it('rejects keys longer than the max length', () => {
    const errs = validateUpdateAiSettings({ apiKey: 'x'.repeat(AI_API_KEY_MAX_LENGTH + 1) })
    expect(errs.join(' ')).toContain('exceed')
  })

  it('accepts keys at the max length boundary', () => {
    expect(
      validateUpdateAiSettings({ apiKey: 'x'.repeat(AI_API_KEY_MAX_LENGTH) }),
    ).toEqual([])
  })
})

describe('validateUpdateAiSettings — model', () => {
  it('accepts a non-empty string', () => {
    expect(validateUpdateAiSettings({ model: 'claude-4.5-sonnet' })).toEqual([])
  })

  it('accepts null as an explicit clear', () => {
    expect(validateUpdateAiSettings({ model: null })).toEqual([])
  })

  it('rejects an empty / whitespace-only string', () => {
    expect(validateUpdateAiSettings({ model: '' })).not.toEqual([])
    expect(validateUpdateAiSettings({ model: '   ' })).not.toEqual([])
  })

  it('rejects strings longer than the max length', () => {
    const errs = validateUpdateAiSettings({ model: 'x'.repeat(AI_MODEL_MAX_LENGTH + 1) })
    expect(errs.join(' ')).toContain('exceed')
  })
})

describe('validateUpdateAiSettings — temperature', () => {
  it('accepts numbers in range', () => {
    expect(validateUpdateAiSettings({ temperature: AI_TEMPERATURE_MIN })).toEqual([])
    expect(validateUpdateAiSettings({ temperature: 0.7 })).toEqual([])
    expect(validateUpdateAiSettings({ temperature: AI_TEMPERATURE_MAX })).toEqual([])
  })

  it('accepts null as an explicit clear', () => {
    expect(validateUpdateAiSettings({ temperature: null })).toEqual([])
  })

  it('rejects out-of-range values', () => {
    expect(validateUpdateAiSettings({ temperature: -0.1 })).not.toEqual([])
    expect(validateUpdateAiSettings({ temperature: AI_TEMPERATURE_MAX + 0.1 })).not.toEqual([])
  })

  it('rejects non-finite numbers', () => {
    expect(validateUpdateAiSettings({ temperature: Number.NaN })).not.toEqual([])
    expect(validateUpdateAiSettings({ temperature: Number.POSITIVE_INFINITY })).not.toEqual([])
  })

  it('rejects non-number types', () => {
    expect(validateUpdateAiSettings({ temperature: '0.5' })).not.toEqual([])
  })
})

describe('validateUpdateAiSettings — maxTokens', () => {
  it('accepts integers in range', () => {
    expect(validateUpdateAiSettings({ maxTokens: AI_MAX_TOKENS_MIN })).toEqual([])
    expect(validateUpdateAiSettings({ maxTokens: 4096 })).toEqual([])
    expect(validateUpdateAiSettings({ maxTokens: AI_MAX_TOKENS_MAX })).toEqual([])
  })

  it('accepts null as an explicit clear', () => {
    expect(validateUpdateAiSettings({ maxTokens: null })).toEqual([])
  })

  it('rejects non-integer numbers', () => {
    expect(validateUpdateAiSettings({ maxTokens: 4096.5 })).not.toEqual([])
  })

  it('rejects out-of-range values', () => {
    expect(validateUpdateAiSettings({ maxTokens: 0 })).not.toEqual([])
    expect(validateUpdateAiSettings({ maxTokens: AI_MAX_TOKENS_MAX + 1 })).not.toEqual([])
  })

  it('rejects non-number types', () => {
    expect(validateUpdateAiSettings({ maxTokens: '4096' })).not.toEqual([])
  })
})

describe('validateUpdateAiSettings — aggregation', () => {
  it('reports every field problem in a single response', () => {
    const errs = validateUpdateAiSettings({
      provider: 'nope',
      defaultAgent: 'nope',
      apiKey: '',
      model: '',
      temperature: 99,
      maxTokens: 'x',
      unknown: 1,
    })
    expect(errs.length).toBeGreaterThanOrEqual(6)
    const joined = errs.join(' ')
    expect(joined).toContain('provider')
    expect(joined).toContain('defaultAgent')
    expect(joined).toContain('apiKey')
    expect(joined).toContain('model')
    expect(joined).toContain('temperature')
    expect(joined).toContain('maxTokens')
    expect(joined).toContain('unknown')
  })
})
