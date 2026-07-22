/**
 * Tests for the encrypted credential store service
 * (server/src/services/credentials.ts).
 *
 * Covers:
 *   – AES-256-GCM encryption/decryption round-trip (including tamper detection)
 *   – save / get / list / delete operations
 *   – per-user vs system (null user) scoping isolation
 *   – metadata-only list (never exposes ciphertext/iv/plaintext)
 *   – input validation (key, userId, secret)
 *   – fail-fast master key resolution in production
 *   – ephemeral dev key + accepted master key encodings
 *   – secret material never leaks in list output or errors
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  encryptSecret,
  decryptSecret,
  saveCredential,
  getCredentialSecret,
  listCredentials,
  removeCredential,
} from '../server/src/services/credentials.js'
import { getDb, closeDb, resetDb } from '../server/src/db/index.js'

const originalMasterKey = process.env['CREDENTIALS_MASTER_KEY']
const originalNodeEnv = process.env['NODE_ENV']

beforeEach(() => {
  // Fresh in-memory DB for each test.
  resetDb()
})

afterAll(() => {
  closeDb()
  if (originalMasterKey === undefined) delete process.env['CREDENTIALS_MASTER_KEY']
  else process.env['CREDENTIALS_MASTER_KEY'] = originalMasterKey
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = originalNodeEnv
})

// ── Encryption round-trip primitives ─────────────────────────────────────────

describe('encryptSecret / decryptSecret round-trip', () => {
  it('decrypts to the original plaintext', () => {
    const secret = 'super-secret-smtp-password-123!'
    const { ciphertext, iv } = encryptSecret(secret)
    expect(decryptSecret(ciphertext, iv)).toBe(secret)
  })

  it('produces a fresh IV on every call (nonce reuse protection)', () => {
    const a = encryptSecret('same')
    const b = encryptSecret('same')
    expect(a.iv).not.toBe(b.iv)
    // Different IVs encrypt the same plaintext to different ciphertexts.
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('handles unicode / multi-byte plaintext', () => {
    const secret = 'p@sswörd-🔐-日本語'
    const { ciphertext, iv } = encryptSecret(secret)
    expect(decryptSecret(ciphertext, iv)).toBe(secret)
  })

  it('handles long plaintext (SSH private key-sized)', () => {
    const secret = 'A'.repeat(4096)
    const { ciphertext, iv } = encryptSecret(secret)
    expect(decryptSecret(ciphertext, iv)).toBe(secret)
  })

  it('detects ciphertext tampering via the GCM auth tag', () => {
    const { ciphertext, iv } = encryptSecret('topsecret')
    // Flip a bit in the ciphertext body (before the trailing 16-byte tag).
    const buf = Buffer.from(ciphertext, 'base64')
    buf[0] ^= 0x01
    const tampered = buf.toString('base64')
    expect(() => decryptSecret(tampered, iv)).toThrow()
  })

  it('detects a corrupted auth tag', () => {
    const { ciphertext, iv } = encryptSecret('topsecret')
    const buf = Buffer.from(ciphertext, 'base64')
    // Flip a byte in the trailing 16-byte tag region.
    buf[buf.length - 1] ^= 0x01
    const tampered = buf.toString('base64')
    expect(() => decryptSecret(tampered, iv)).toThrow()
  })

  it('rejects an IV of the wrong length', () => {
    const { ciphertext } = encryptSecret('x')
    expect(() =>
      decryptSecret(ciphertext, Buffer.alloc(8).toString('base64')),
    ).toThrow(/IV length/)
  })

  it('rejects ciphertext too short to contain an auth tag', () => {
    const { iv } = encryptSecret('x')
    const tooShort = Buffer.alloc(8, 0x41).toString('base64')
    expect(() => decryptSecret(tooShort, iv)).toThrow(/too short/)
  })
})

// ── save / get / list / delete ────────────────────────────────────────────────

describe('saveCredential / getCredentialSecret', () => {
  it('round-trips a per-user credential', () => {
    const id = saveCredential('u-1', 'smtp_password', 'hunter2')
    expect(id).toBe('u-1:smtp_password')
    expect(getCredentialSecret('u-1', 'smtp_password')).toBe('hunter2')
  })

  it('round-trips a system (null user) credential', () => {
    const id = saveCredential(null, 'ai_api_key', 'sk-abc123')
    expect(id).toBe('system:ai_api_key')
    expect(getCredentialSecret(null, 'ai_api_key')).toBe('sk-abc123')
  })

  it('returns undefined for an unknown credential', () => {
    expect(getCredentialSecret('u-9', 'missing')).toBeUndefined()
    expect(getCredentialSecret(null, 'missing')).toBeUndefined()
  })

  it('updates an existing credential in place (same id, new value)', () => {
    saveCredential('u-2', 'ssh_key', 'old-key')
    saveCredential('u-2', 'ssh_key', 'new-key')
    expect(getCredentialSecret('u-2', 'ssh_key')).toBe('new-key')
  })

  it('isolates per-user and system scopes with the same key', () => {
    saveCredential('u-a', 'shared', 'user-a-value')
    saveCredential('u-b', 'shared', 'user-b-value')
    saveCredential(null, 'shared', 'system-value')
    expect(getCredentialSecret('u-a', 'shared')).toBe('user-a-value')
    expect(getCredentialSecret('u-b', 'shared')).toBe('user-b-value')
    expect(getCredentialSecret(null, 'shared')).toBe('system-value')
    // A system lookup must not see a user credential.
    expect(getCredentialSecret(null, 'shared')).not.toBe('user-a-value')
  })

  it('wraps decryption errors without leaking the raw crypto detail', () => {
    saveCredential('u-3', 'k', 'v')
    // Corrupt the stored ciphertext directly in the DB to simulate tampering.
    const db = getDb()
    db.prepare(
      "UPDATE credentials SET encrypted_value = 'AAAAAAAAAAAAAAAA' WHERE user_id = ? AND key = ?",
    ).run('u-3', 'k')
    expect(() => getCredentialSecret('u-3', 'k')).toThrow(/Failed to decrypt/)
  })
})

describe('listCredentials', () => {
  beforeEach(() => {
    saveCredential('u-1', 'beta', 'v1')
    saveCredential('u-1', 'alpha', 'v2')
    saveCredential('u-2', 'gamma', 'v3')
    saveCredential(null, 'system_key', 'v4')
  })

  it('returns metadata only — never ciphertext, iv, or plaintext', () => {
    const all = listCredentials()
    for (const item of all) {
      expect(item).not.toHaveProperty('encrypted_value')
      expect(item).not.toHaveProperty('iv')
      expect(item).not.toHaveProperty('value')
      // Stringify to ensure no secret material is present anywhere in the
      // metadata shape.
      const serialized = JSON.stringify(item)
      expect(serialized).not.toContain('v1')
      expect(serialized).not.toContain('v2')
      expect(serialized).not.toContain('v3')
      expect(serialized).not.toContain('v4')
    }
  })

  it('includes the expected metadata fields', () => {
    const all = listCredentials()
    expect(all.length).toBe(4)
    for (const item of all) {
      expect(typeof item.id).toBe('string')
      expect(['u-1', 'u-2', null]).toContain(item.userId)
      expect(typeof item.key).toBe('string')
      expect(typeof item.createdAt).toBe('string')
      expect(typeof item.updatedAt).toBe('string')
    }
  })

  it('filters to a specific user when userId is provided', () => {
    const forUser1 = listCredentials('u-1')
    expect(forUser1).toHaveLength(2)
    expect(forUser1.every((c) => c.userId === 'u-1')).toBe(true)
    expect(forUser1.map((c) => c.key)).toEqual(['alpha', 'beta'])
  })

  it('filters to system credentials when userId is null', () => {
    const system = listCredentials(null)
    expect(system).toHaveLength(1)
    expect(system[0].userId).toBeNull()
    expect(system[0].key).toBe('system_key')
  })

  it('returns all credentials when userId is omitted', () => {
    const all = listCredentials()
    expect(all.length).toBe(4)
    // System credentials sort first (user_id IS NULL DESC), then by user/key.
    expect(all[0].userId).toBeNull()
  })

  it('returns an empty array when nothing matches', () => {
    expect(listCredentials('nobody')).toEqual([])
    expect(listCredentials(null)).not.toEqual([]) // has system_key from beforeEach
    resetDb()
    expect(listCredentials()).toEqual([])
    expect(listCredentials(null)).toEqual([])
  })
})

describe('removeCredential', () => {
  it('deletes an existing credential and returns true', () => {
    saveCredential('u-1', 'temp', 'v')
    expect(removeCredential('u-1', 'temp')).toBe(true)
    expect(getCredentialSecret('u-1', 'temp')).toBeUndefined()
  })

  it('returns false when no credential existed', () => {
    expect(removeCredential('u-1', 'never')).toBe(false)
  })

  it('does not delete a different user credential with the same key', () => {
    saveCredential('u-a', 'shared', 'a')
    saveCredential('u-b', 'shared', 'b')
    expect(removeCredential('u-a', 'shared')).toBe(true)
    expect(getCredentialSecret('u-b', 'shared')).toBe('b')
  })

  it('deletes system credentials independently of user credentials', () => {
    saveCredential(null, 'shared', 'sys')
    saveCredential('u-1', 'shared', 'user')
    expect(removeCredential(null, 'shared')).toBe(true)
    expect(getCredentialSecret(null, 'shared')).toBeUndefined()
    expect(getCredentialSecret('u-1', 'shared')).toBe('user')
  })
})

// ── Input validation ─────────────────────────────────────────────────────────

describe('input validation', () => {
  it('rejects an empty key name', () => {
    expect(() => saveCredential('u-1', '', 'v')).toThrow(/non-empty string/)
    expect(() => getCredentialSecret('u-1', '')).toThrow(/non-empty string/)
    expect(() => removeCredential('u-1', '')).toThrow(/non-empty string/)
  })

  it('rejects a non-string key name', () => {
    expect(() => saveCredential('u-1', 42 as unknown as string, 'v')).toThrow(
      /non-empty string/,
    )
    expect(() => saveCredential('u-1', null as unknown as string, 'v')).toThrow(
      /non-empty string/,
    )
  })

  it('rejects key names with control characters', () => {
    expect(() => saveCredential('u-1', 'bad\nkey', 'v')).toThrow(/control characters/)
    expect(() => saveCredential('u-1', 'bad\x00key', 'v')).toThrow(/control characters/)
  })

  it('rejects over-long key names', () => {
    expect(() => saveCredential('u-1', 'x'.repeat(129), 'v')).toThrow(/at most 128/)
  })

  it('rejects an empty secret', () => {
    expect(() => saveCredential('u-1', 'k', '')).toThrow(/non-empty string/)
  })

  it('rejects a non-string secret', () => {
    expect(() => saveCredential('u-1', 'k', 123 as unknown as string)).toThrow(
      /must be a string/,
    )
  })

  it('accepts userId = null as the system scope', () => {
    expect(() => saveCredential(null, 'k', 'v')).not.toThrow()
    expect(getCredentialSecret(null, 'k')).toBe('v')
  })

  it('accepts userId = undefined as the system scope', () => {
    expect(() =>
      saveCredential(undefined as unknown as null, 'k2', 'v'),
    ).not.toThrow()
    expect(getCredentialSecret(null, 'k2')).toBe('v')
  })

  it('rejects an empty-string userId', () => {
    expect(() => saveCredential('', 'k', 'v')).toThrow(/non-empty string/)
  })

  it('rejects a non-string userId', () => {
    expect(() => saveCredential(42 as unknown as null, 'k', 'v')).toThrow(
      /non-empty string/,
    )
  })

  it('rejects userId with control characters', () => {
    expect(() => saveCredential('bad\nid', 'k', 'v')).toThrow(/control characters/)
  })
})

// ── Master key resolution ─────────────────────────────────────────────────────

describe('master key resolution', () => {
  it('accepts a 32-byte hex-encoded key (round-trips data)', () => {
    process.env['CREDENTIALS_MASTER_KEY'] = 'a'.repeat(64)
    const { ciphertext, iv } = encryptSecret('test')
    expect(decryptSecret(ciphertext, iv)).toBe('test')
  })

  it('accepts a 32-byte base64-encoded key (round-trips data)', () => {
    process.env['CREDENTIALS_MASTER_KEY'] = Buffer.alloc(32, 0xab).toString('base64')
    const { ciphertext, iv } = encryptSecret('test')
    expect(decryptSecret(ciphertext, iv)).toBe('test')
  })

  it('throws for an invalid master key format (wrong length hex)', () => {
    process.env['CREDENTIALS_MASTER_KEY'] = 'a'.repeat(32) // 16 bytes, too short
    expect(() => {
      vi.resetModules()
      require('../server/src/services/credentials.js')
    }).toThrow(/32 bytes/)
  })

  it('throws for an invalid master key format (junk)', () => {
    process.env['CREDENTIALS_MASTER_KEY'] = 'not-valid-key-material!'
    expect(() => {
      vi.resetModules()
      require('../server/src/services/credentials.js')
    }).toThrow(/32 bytes/)
  })

  it('throws when missing in production (fail-closed)', () => {
    process.env['NODE_ENV'] = 'production'
    delete process.env['CREDENTIALS_MASTER_KEY']
    expect(() => {
      vi.resetModules()
      require('../server/src/services/credentials.js')
    }).toThrow(/must be set in production/)
  })

  it('throws when empty in production (fail-closed)', () => {
    process.env['NODE_ENV'] = 'production'
    process.env['CREDENTIALS_MASTER_KEY'] = '   '
    expect(() => {
      vi.resetModules()
      require('../server/src/services/credentials.js')
    }).toThrow(/must be set in production/)
  })

  it('warns and uses an ephemeral key when unset in development', () => {
    delete process.env['CREDENTIALS_MASTER_KEY']
    process.env['NODE_ENV'] = 'development'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    // Importing fresh triggers the ephemeral-key branch + warning.
    const mod = require('../server/src/services/credentials.js') as typeof import(
      '../server/src/services/credentials.js'
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ephemeral key'),
    )
    // The ephemeral-derived key still round-trips within this module load.
    const { ciphertext, iv } = mod.encryptSecret('round-trip')
    expect(mod.decryptSecret(ciphertext, iv)).toBe('round-trip')
    warnSpy.mockRestore()
  })

  it('uses different ciphertext for the same plaintext across master-key changes', () => {
    // Re-deriving under a different key means the same plaintext produces a
    // different ciphertext blob (different derived key + fresh IV).
    process.env['CREDENTIALS_MASTER_KEY'] = 'a'.repeat(64)
    const a = encryptSecret('same')
    process.env['CREDENTIALS_MASTER_KEY'] = 'b'.repeat(64)
    vi.resetModules()
    const mod = require('../server/src/services/credentials.js') as typeof import(
      '../server/src/services/credentials.js'
    )
    const b = mod.encryptSecret('same')
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })
})

// ── Cross-process persistence of encryption ───────────────────────────────────

describe('persistence semantics', () => {
  it('ciphertext is base64 and IV is base64 in the stored row', () => {
    saveCredential('u-1', 'k', 'v')
    const db = getDb()
    const row = db
      .prepare(
        'SELECT encrypted_value, iv FROM credentials WHERE user_id = ? AND key = ?',
      )
      .get('u-1', 'k') as { encrypted_value: string; iv: string }
    // Both must be valid base64.
    expect(Buffer.from(row.encrypted_value, 'base64').toString('base64')).toBe(
      row.encrypted_value,
    )
    expect(Buffer.from(row.iv, 'base64').toString('base64')).toBe(row.iv)
    // IV must be exactly 12 bytes.
    expect(Buffer.from(row.iv, 'base64').length).toBe(12)
    // The stored ciphertext must NOT contain the plaintext.
    expect(row.encrypted_value).not.toContain('v')
  })
})
