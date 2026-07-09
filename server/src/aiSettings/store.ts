/**
 * In-memory AI settings store.
 *
 * Holds a per-user record with an encrypted API key blob. The store never
 * returns the plaintext key to the route layer — the only exposed accessors
 * are `getView` (returns a redacted view) and `getApiKeyPlaintext` (returns
 * the decrypted key, intended solely for outbound provider calls the server
 * makes on behalf of the user; e.g. a future developmental-task runner).
 *
 * Persistence
 * ───────────
 * State lives in a `Map` today. Swap this class out for a Postgres- or
 * Redis-backed implementation when durability is required; the interface
 * (`getSettings`, `updateSettings`, `hasApiKey`, `getApiKeyPlaintext`) is the
 * seam a persistent adapter must satisfy. Encrypted-at-rest storage is
 * mandatory for any adapter that writes to disk — the `Encryptor` is the
 * exact primitive to reuse.
 */

import type { AgentName } from '../tasks/types.js'
import { Encryptor } from './encryption.js'
import type { AiProvider, AiSettingsView, UpdateAiSettingsInput } from './types.js'

interface StoredSettings {
  userId: string
  provider: AiProvider | null
  defaultAgent: AgentName | null
  model: string | null
  temperature: number | null
  maxTokens: number | null
  /**
   * Ciphertext produced by `Encryptor.encrypt`. `null` means "no key set".
   * The plaintext is never held in this object.
   */
  encryptedApiKey: string | null
  updatedAt: string
}

/**
 * Empty defaults returned to the client when a user has never touched their
 * settings. Kept as a factory to guarantee callers get a fresh `updatedAt`
 * timestamp on each call (a shared literal would freeze `updatedAt` at
 * module-load time).
 */
function emptyView(): AiSettingsView {
  return {
    provider: null,
    defaultAgent: null,
    model: null,
    temperature: null,
    maxTokens: null,
    hasApiKey: false,
    updatedAt: new Date(0).toISOString(),
  }
}

function toView(record: StoredSettings): AiSettingsView {
  return {
    provider: record.provider,
    defaultAgent: record.defaultAgent,
    model: record.model,
    temperature: record.temperature,
    maxTokens: record.maxTokens,
    hasApiKey: record.encryptedApiKey !== null,
    updatedAt: record.updatedAt,
  }
}

export interface AiSettingsStoreOptions {
  /**
   * AES-256-GCM encryptor used to seal the API key at rest. Callers own the
   * key material — see `resolveAiEncryptor` in `./config.ts` for the standard
   * env-driven bootstrap.
   */
  encryptor: Encryptor
}

/**
 * Thin, well-typed API over the underlying `Map`. Kept small so a database-
 * backed replacement is a straight port.
 */
export class AiSettingsStore {
  private readonly records = new Map<string, StoredSettings>()
  private readonly encryptor: Encryptor

  constructor(options: AiSettingsStoreOptions) {
    this.encryptor = options.encryptor
  }

  /** Return the redacted view for a user, or defaults when none exists. */
  getSettings(userId: string): AiSettingsView {
    const record = this.records.get(userId)
    return record ? toView(record) : emptyView()
  }

  /** True when a plaintext API key is currently sealed for the given user. */
  hasApiKey(userId: string): boolean {
    return this.records.get(userId)?.encryptedApiKey != null
  }

  /**
   * Decrypt and return the plaintext API key for the given user. Returns
   * `null` when no key is stored. Never expose this to API responses — the
   * only legitimate use is a server-side outbound call to the AI provider.
   */
  getApiKeyPlaintext(userId: string): string | null {
    const record = this.records.get(userId)
    if (!record || record.encryptedApiKey == null) return null
    return this.encryptor.decrypt(record.encryptedApiKey)
  }

  /**
   * Apply a partial update. Only fields the caller supplied are touched;
   * omitted fields retain their current value.
   *
   * Semantics of `null`:
   *  - `provider`, `defaultAgent`, `model`, `temperature`, `maxTokens`: clear.
   *  - `apiKey`: clear the sealed key.
   *
   * The plaintext `apiKey` value is encrypted immediately and never stored
   * on the record.
   */
  updateSettings(userId: string, patch: UpdateAiSettingsInput): AiSettingsView {
    const now = new Date().toISOString()
    const existing = this.records.get(userId)

    const base: StoredSettings = existing ?? {
      userId,
      provider: null,
      defaultAgent: null,
      model: null,
      temperature: null,
      maxTokens: null,
      encryptedApiKey: null,
      updatedAt: now,
    }

    const next: StoredSettings = {
      ...base,
      // `undefined` on a patch field means "no change"; `null` means "clear".
      provider: patch.provider === undefined ? base.provider : patch.provider,
      defaultAgent:
        patch.defaultAgent === undefined ? base.defaultAgent : patch.defaultAgent,
      model: patch.model === undefined ? base.model : patch.model,
      temperature: patch.temperature === undefined ? base.temperature : patch.temperature,
      maxTokens: patch.maxTokens === undefined ? base.maxTokens : patch.maxTokens,
      encryptedApiKey:
        patch.apiKey === undefined
          ? base.encryptedApiKey
          : patch.apiKey === null
            ? null
            : this.encryptor.encrypt(patch.apiKey),
      updatedAt: now,
    }

    this.records.set(userId, next)
    return toView(next)
  }

  /** Test helper — number of users with any stored settings. */
  size(): number {
    return this.records.size
  }
}
