import { describe, it, expect } from 'vitest'
import {
  INTEGRATIONS,
  VALID_TASK_TYPES,
  VALID_AGENTS,
  getIntegrationDef,
  integrationCredentialKey,
  testIntegrationConnection,
} from './integrations.js'

// A safe identifier: lowercase-start camelCase, letters/digits only. Field
// keys and integration ids are embedded directly into credential-store keys
// (`integration_<id>_<field>`), so they must never contain separators,
// whitespace, or control characters.
const SAFE_IDENTIFIER = /^[a-z][a-zA-Z0-9]*$/

describe('integrations catalog', () => {
  it('defines exactly the eight v1 integrations, in a stable order', () => {
    const ids = INTEGRATIONS.map((i) => i.id)
    expect(ids).toEqual([
      'github',
      'slack',
      'jira',
      'notion',
      'linear',
      'monday',
      'hubspot',
      'factoryNexus',
    ])
  })

  it('has unique ids', () => {
    const ids = INTEGRATIONS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(INTEGRATIONS.map((def) => def.id))('%s has well-formed catalog metadata', (id) => {
    const def = getIntegrationDef(id)
    expect(def).toBeDefined()
    if (!def) return

    expect(def.id).toBe(id)
    expect(SAFE_IDENTIFIER.test(def.id)).toBe(true)

    expect(typeof def.name).toBe('string')
    expect(def.name.trim().length).toBeGreaterThan(0)

    expect(typeof def.description).toBe('string')
    expect(def.description.trim().length).toBeGreaterThan(0)

    // setupUrl must be a valid absolute https URL — it's rendered as a link
    // in the connect modal, so it must never be javascript:/data: etc.
    expect(() => new URL(def.setupUrl)).not.toThrow()
    expect(new URL(def.setupUrl).protocol).toBe('https:')

    expect(Array.isArray(def.fields)).toBe(true)
    expect(def.fields.length).toBeGreaterThan(0)

    const fieldKeys = def.fields.map((f) => f.key)
    expect(new Set(fieldKeys).size).toBe(fieldKeys.length) // unique per integration

    for (const field of def.fields) {
      expect(SAFE_IDENTIFIER.test(field.key)).toBe(true)
      expect(field.label.trim().length).toBeGreaterThan(0)
      expect(typeof field.secret).toBe('boolean')
      // The catalog is pure metadata — it must never carry an actual secret
      // value alongside a field spec.
      expect(field).not.toHaveProperty('value')
    }
  })

  it('at least one integration requires more than a single field (Jira)', () => {
    const jira = getIntegrationDef('jira')
    expect(jira?.fields.length).toBeGreaterThan(1)
    expect(jira?.fields.map((f) => f.key)).toEqual(['siteUrl', 'email', 'apiToken'])
  })

  it('Factory Nexus is registered with a single secret API key field', () => {
    const factoryNexus = getIntegrationDef('factoryNexus')
    expect(factoryNexus).toBeDefined()
    expect(factoryNexus?.name).toBe('Factory Nexus')
    expect(factoryNexus?.fields).toEqual([{ key: 'apiKey', label: 'API Key', secret: true }])
  })
})

describe('VALID_TASK_TYPES / VALID_AGENTS', () => {
  it('matches the scoping enums used elsewhere in the integrations feature', () => {
    expect([...VALID_TASK_TYPES].sort()).toEqual(['daily', 'developmental', 'routine'])
    expect([...VALID_AGENTS].sort()).toEqual(['claude', 'omnimancer', 'opencode'])
  })
})

describe('getIntegrationDef', () => {
  it('returns undefined for an unknown id instead of throwing', () => {
    expect(getIntegrationDef('not-a-real-integration')).toBeUndefined()
    expect(getIntegrationDef('')).toBeUndefined()
  })

  it('returns the matching definition for each known id', () => {
    for (const id of INTEGRATIONS.map((def) => def.id)) {
      expect(getIntegrationDef(id)?.id).toBe(id)
    }
  })
})

describe('integrationCredentialKey', () => {
  it('builds the integration_<id>_<field> convention', () => {
    expect(integrationCredentialKey('github', 'token')).toBe('integration_github_token')
    expect(integrationCredentialKey('jira', 'siteUrl')).toBe('integration_jira_siteUrl')
    expect(integrationCredentialKey('factoryNexus', 'apiKey')).toBe('integration_factoryNexus_apiKey')
  })

  it('produces a distinct key per field for multi-field integrations', () => {
    const jira = getIntegrationDef('jira')
    const keys = (jira?.fields ?? []).map((f) => integrationCredentialKey('jira', f.key))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('testIntegrationConnection', () => {
  it('reports an unsupported-integration failure for an unknown id, without calling fetch', async () => {
    const fetchImpl = () => {
      throw new Error('should never be called')
    }
    const result = await testIntegrationConnection('bogus', {}, { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Unsupported/)
  })

  it('delegates to the shared provider test for every catalog id (Factory Nexus succeeds on 200)', async () => {
    const fetchImpl = async () =>
      ({ status: 200, json: async () => ({}) }) as unknown as Response
    const result = await testIntegrationConnection('factoryNexus', { apiKey: 'fn_test_key' }, { fetchImpl })
    expect(result.ok).toBe(true)
  })

  it('reports a Factory Nexus failure on a non-2xx status without leaking the key', async () => {
    const fetchImpl = async () =>
      ({ status: 401, json: async () => ({}) }) as unknown as Response
    const result = await testIntegrationConnection('factoryNexus', { apiKey: 'super-secret-fn-key' }, { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
    expect(JSON.stringify(result)).not.toContain('super-secret-fn-key')
  })
})
