/**
 * Unit tests for AiSettingsStore.
 *
 * Focus areas
 * ───────────
 *  - Per-user isolation: user A's writes never affect user B's view.
 *  - Redaction: the returned view never carries the plaintext API key.
 *  - Partial updates: omitted fields retain their previous value; null clears.
 *  - API-key round-trip via `getApiKeyPlaintext` after encryption at rest.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { AiSettingsStore } from '../server/src/aiSettings/store.js'
import { Encryptor, generateEncryptionKey } from '../server/src/aiSettings/encryption.js'

function makeStore(): AiSettingsStore {
  return new AiSettingsStore({ encryptor: new Encryptor(generateEncryptionKey()) })
}

let store: AiSettingsStore

beforeEach(() => {
  store = makeStore()
})

describe('AiSettingsStore.getSettings — defaults', () => {
  it('returns nulls when the user has no settings', () => {
    const view = store.getSettings('user-1')
    expect(view.provider).toBeNull()
    expect(view.defaultAgent).toBeNull()
    expect(view.model).toBeNull()
    expect(view.temperature).toBeNull()
    expect(view.maxTokens).toBeNull()
    expect(view.hasApiKey).toBe(false)
    expect(typeof view.updatedAt).toBe('string')
  })

  it('does not leak an apiKey field on the view', () => {
    const view = store.getSettings('user-1') as Record<string, unknown>
    expect(view.apiKey).toBeUndefined()
    expect(view.encryptedApiKey).toBeUndefined()
  })
})

describe('AiSettingsStore.updateSettings — write path', () => {
  it('persists all fields in one write', () => {
    const view = store.updateSettings('user-1', {
      provider: 'claude-code',
      apiKey: 'sk-live-abc',
      defaultAgent: 'claude-code',
      model: 'claude-4.5-sonnet',
      temperature: 0.7,
      maxTokens: 4096,
    })
    expect(view).toMatchObject({
      provider: 'claude-code',
      defaultAgent: 'claude-code',
      model: 'claude-4.5-sonnet',
      temperature: 0.7,
      maxTokens: 4096,
      hasApiKey: true,
    })
  })

  it('never returns the raw API key', () => {
    const view = store.updateSettings('user-1', {
      apiKey: 'sk-secret-99',
    })
    const asObj = view as Record<string, unknown>
    expect(asObj.apiKey).toBeUndefined()
    expect(asObj.encryptedApiKey).toBeUndefined()
    expect(view.hasApiKey).toBe(true)
  })

  it('leaves unrelated fields unchanged on partial updates', () => {
    store.updateSettings('user-1', {
      provider: 'opencode',
      defaultAgent: 'opencode',
      model: 'x1',
    })
    const view = store.updateSettings('user-1', { model: 'x2' })
    expect(view.provider).toBe('opencode')
    expect(view.defaultAgent).toBe('opencode')
    expect(view.model).toBe('x2')
  })

  it('clears fields when null is passed explicitly', () => {
    store.updateSettings('user-1', {
      provider: 'omnimancer',
      defaultAgent: 'omnimancer',
      model: 'legacy',
      temperature: 1.2,
      maxTokens: 2048,
      apiKey: 'sk-legacy',
    })
    const view = store.updateSettings('user-1', {
      provider: null,
      defaultAgent: null,
      model: null,
      temperature: null,
      maxTokens: null,
      apiKey: null,
    })
    expect(view.provider).toBeNull()
    expect(view.defaultAgent).toBeNull()
    expect(view.model).toBeNull()
    expect(view.temperature).toBeNull()
    expect(view.maxTokens).toBeNull()
    expect(view.hasApiKey).toBe(false)
    expect(store.getApiKeyPlaintext('user-1')).toBeNull()
  })

  it('preserves the API key when the patch omits the apiKey field', () => {
    store.updateSettings('user-1', { apiKey: 'sk-preserve' })
    store.updateSettings('user-1', { model: 'anything' })
    expect(store.hasApiKey('user-1')).toBe(true)
    expect(store.getApiKeyPlaintext('user-1')).toBe('sk-preserve')
  })

  it('advances updatedAt on every write', async () => {
    const first = store.updateSettings('user-1', { provider: 'opencode' })
    // The store uses an ISO timestamp with millisecond resolution — wait a
    // real millisecond so the second write is guaranteed to have a later
    // timestamp on every platform.
    await new Promise((r) => setTimeout(r, 5))
    const second = store.updateSettings('user-1', { provider: 'claude-code' })
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.updatedAt).getTime(),
    )
  })
})

describe('AiSettingsStore.getApiKeyPlaintext', () => {
  it('returns null when no key is stored', () => {
    expect(store.getApiKeyPlaintext('user-1')).toBeNull()
  })

  it('decrypts the stored key on demand', () => {
    store.updateSettings('user-1', { apiKey: 'sk-plain-1' })
    expect(store.getApiKeyPlaintext('user-1')).toBe('sk-plain-1')
  })

  it('reflects the latest write', () => {
    store.updateSettings('user-1', { apiKey: 'sk-1' })
    store.updateSettings('user-1', { apiKey: 'sk-2' })
    expect(store.getApiKeyPlaintext('user-1')).toBe('sk-2')
  })
})

describe('AiSettingsStore — per-user isolation', () => {
  it('does not leak settings across users', () => {
    store.updateSettings('user-1', { provider: 'claude-code', apiKey: 'sk-a' })
    store.updateSettings('user-2', { provider: 'opencode', apiKey: 'sk-b' })

    const a = store.getSettings('user-1')
    const b = store.getSettings('user-2')

    expect(a.provider).toBe('claude-code')
    expect(b.provider).toBe('opencode')
    expect(store.getApiKeyPlaintext('user-1')).toBe('sk-a')
    expect(store.getApiKeyPlaintext('user-2')).toBe('sk-b')
  })

  it('clearing one user leaves the other unaffected', () => {
    store.updateSettings('user-1', { apiKey: 'sk-a', provider: 'claude-code' })
    store.updateSettings('user-2', { apiKey: 'sk-b', provider: 'opencode' })
    store.updateSettings('user-1', { apiKey: null, provider: null })

    expect(store.hasApiKey('user-1')).toBe(false)
    expect(store.getSettings('user-1').provider).toBeNull()

    expect(store.hasApiKey('user-2')).toBe(true)
    expect(store.getSettings('user-2').provider).toBe('opencode')
    expect(store.getApiKeyPlaintext('user-2')).toBe('sk-b')
  })

  it('does not create a record on GET', () => {
    store.getSettings('probe-user')
    expect(store.size()).toBe(0)
  })
})
