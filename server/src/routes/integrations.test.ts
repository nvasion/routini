import { describe, it, expect } from 'vitest'
import {
  INTEGRATIONS,
  INTEGRATION_IDS,
  getIntegrationDefinition,
  isIntegrationId,
  credentialKey,
  requiredCredentialFieldKeys,
  defaultAllScopes,
} from './integrations.js'

// A safe identifier: lowercase-start camelCase, letters/digits only. Field
// keys and integration ids are embedded directly into credential-store keys
// (`integration_<id>_<field>`), so they must never contain separators,
// whitespace, or control characters.
const SAFE_IDENTIFIER = /^[a-z][a-zA-Z0-9]*$/

const TASK_TYPES = ['daily', 'developmental', 'routine']
const AGENTS = ['claude', 'opencode', 'omnimancer']

describe('integrations catalog', () => {
  it('defines exactly the seven v1 integrations', () => {
    expect(INTEGRATION_IDS).toEqual([
      'github',
      'slack',
      'jira',
      'notion',
      'linear',
      'monday',
      'hubspot',
    ])
    expect(INTEGRATIONS).toHaveLength(7)
  })

  it('has unique ids matching the catalog order', () => {
    const ids = INTEGRATIONS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...INTEGRATION_IDS])
  })

  it.each(INTEGRATION_IDS)('%s has well-formed metadata', (id) => {
    const def = getIntegrationDefinition(id)
    expect(def).toBeDefined()
    if (!def) return

    expect(def.id).toBe(id)
    expect(SAFE_IDENTIFIER.test(def.id)).toBe(true)

    expect(typeof def.name).toBe('string')
    expect(def.name.trim().length).toBeGreaterThan(0)

    expect(typeof def.description).toBe('string')
    expect(def.description.trim().length).toBeGreaterThan(0)

    expect(typeof def.setupInstructions).toBe('string')
    expect(def.setupInstructions.trim().length).toBeGreaterThan(0)

    // setupUrl must be a valid absolute https URL — it's rendered as a link
    // in the connect modal, so it must never be javascript:/data: etc.
    expect(() => new URL(def.setupUrl)).not.toThrow()
    expect(new URL(def.setupUrl).protocol).toBe('https:')

    expect(Array.isArray(def.credentialFields)).toBe(true)
    expect(def.credentialFields.length).toBeGreaterThan(0)

    const fieldKeys = def.credentialFields.map((f) => f.key)
    expect(new Set(fieldKeys).size).toBe(fieldKeys.length) // unique per integration

    for (const field of def.credentialFields) {
      expect(SAFE_IDENTIFIER.test(field.key)).toBe(true)
      expect(field.label.trim().length).toBeGreaterThan(0)
      expect(['text', 'password', 'url', 'email']).toContain(field.type)
      expect(typeof field.required).toBe('boolean')
      // The catalog is pure metadata — it must never carry an actual secret
      // value alongside a field spec.
      expect(field).not.toHaveProperty('value')
      expect(field).not.toHaveProperty('secret')
    }
  })

  it('every integration defaults to all task types and all agents', () => {
    for (const def of INTEGRATIONS) {
      expect([...def.defaultScopes.taskTypes].sort()).toEqual([...TASK_TYPES].sort())
      expect([...def.defaultScopes.agents].sort()).toEqual([...AGENTS].sort())
    }
  })

  it('defaultAllScopes returns a fresh object each call', () => {
    const a = defaultAllScopes()
    const b = defaultAllScopes()
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    a.taskTypes.push('daily')
    expect(b.taskTypes).toEqual(['daily', 'developmental', 'routine']) // unaffected by mutation of `a`
  })

  it('at least one integration requires more than a single field (Jira)', () => {
    const jira = getIntegrationDefinition('jira')
    expect(jira?.credentialFields.length).toBeGreaterThan(1)
    expect(requiredCredentialFieldKeys('jira')).toEqual(
      expect.arrayContaining(['siteUrl', 'email', 'apiToken']),
    )
  })
})

describe('isIntegrationId', () => {
  it('accepts every catalog id', () => {
    for (const id of INTEGRATION_IDS) {
      expect(isIntegrationId(id)).toBe(true)
    }
  })

  it('rejects unknown strings, non-strings, and case variants', () => {
    expect(isIntegrationId('github ')).toBe(false)
    expect(isIntegrationId('GitHub')).toBe(false)
    expect(isIntegrationId('gmail')).toBe(false) // later-execution integration, not v1
    expect(isIntegrationId('')).toBe(false)
    expect(isIntegrationId(undefined)).toBe(false)
    expect(isIntegrationId(null)).toBe(false)
    expect(isIntegrationId(42)).toBe(false)
    expect(isIntegrationId({})).toBe(false)
  })
})

describe('getIntegrationDefinition', () => {
  it('returns undefined for an unknown id instead of throwing', () => {
    expect(getIntegrationDefinition('not-a-real-integration')).toBeUndefined()
    expect(getIntegrationDefinition('')).toBeUndefined()
  })

  it('returns the matching definition for each known id', () => {
    for (const id of INTEGRATION_IDS) {
      expect(getIntegrationDefinition(id)?.id).toBe(id)
    }
  })
})

describe('credentialKey', () => {
  it('builds the integration_<id>_<field> convention', () => {
    expect(credentialKey('github', 'token')).toBe('integration_github_token')
    expect(credentialKey('jira', 'siteUrl')).toBe('integration_jira_siteUrl')
  })

  it('throws for a field not declared on the integration', () => {
    expect(() => credentialKey('github', 'botToken')).toThrow(/Unknown credential field/)
  })

  it('throws for an unknown integration id', () => {
    // @ts-expect-error — deliberately passing an invalid id to exercise the guard
    expect(() => credentialKey('not-a-real-integration', 'token')).toThrow(
      /Unknown integration id/,
    )
  })

  it('produces a distinct key per field for multi-field integrations', () => {
    const keys = requiredCredentialFieldKeys('jira').map((f) => credentialKey('jira', f))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('requiredCredentialFieldKeys', () => {
  it('returns only required fields, in declaration order', () => {
    expect(requiredCredentialFieldKeys('github')).toEqual(['token'])
  })

  it('every declared field across the catalog is required in v1', () => {
    // v1 has no optional credential fields; this guards against a future
    // field being added as optional without updating validation logic that
    // assumes requiredCredentialFieldKeys covers every field.
    for (const def of INTEGRATIONS) {
      expect(requiredCredentialFieldKeys(def.id)).toEqual(def.credentialFields.map((f) => f.key))
    }
  })
})
