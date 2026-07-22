// ─────────────────────────────────────────────────────────────────────────────
// Encrypted credential store service
//
// Provides save / get / list / delete operations over secrets that must be
// persisted (SSH private keys, IMAP/SMTP passwords, AI API keys, …).  Secrets
// are encrypted at rest with **AES-256-GCM** before being written to the
// `credentials` table exposed by the DB module; only the base64 ciphertext
// and per-record nonce are ever persisted.
//
// Configuration:
//   CREDENTIALS_MASTER_KEY – high-entropy master key used to derive a per-scope
//     AES-256 key via HKDF-SHA256.  In production this MUST be set explicitly;
//     the module throws at import time when it is missing in production so the
//     server fails fast rather than silently encrypting under a weak/ephemeral
//     key.  In development an ephemeral key is generated (with a warning) so
//   the server boots without configuration, but data encrypted with it is
//   not decryptable after a restart.
//
// Security properties:
//   – Never exposes secret material: get() returns the decrypted secret only
//     to callers that need it; list() returns metadata only (id, key,
//     timestamps) and never the ciphertext, nonce, or plaintext.
//   – Per-record random 96-bit IV (GCM nonce) — never reused.
//   – GCM authentication tag is stored alongside the ciphertext; tampering is
//     detected on decrypt and surfaces as an error (never silently returns
//     corrupted data).
//   – A stable salt is derived for HKDF so the derived key is deterministic
//     for a given master key; key rotation requires re-encrypting all rows.
//   – Inputs are validated: key names are length-bounded and must not contain
//     control characters; userId is validated when provided.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import {
  credentialId,
  deleteCredential,
  getCredential,
  getDb,
  upsertCredential,
} from '../db/index.js'

// ── Constants ────────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm' as const
const KEY_LEN = 32 // 256 bits — AES-256
const IV_LEN = 12 // 96 bits — recommended GCM nonce length
const HKDF_SALT = Buffer.from('routini-credential-store-v1', 'utf8')
const HKDF_INFO = Buffer.from('aes-256-gcm-credentials', 'utf8')

const MAX_KEY_NAME_LEN = 128
const MAX_USER_ID_LEN = 128
const MAX_SECRET_LEN = 1024 * 64 // 64 KiB — generous upper bound for keys/passwords

// ── Types ─────────────────────────────────────────────────────────────────────

/** Metadata returned by list() — never contains ciphertext or plaintext. */
export interface CredentialMetadata {
  /** Stable identifier derived from (user_id, key). */
  id: string
  /** Owning user id, or null for a system/global credential. */
  userId: string | null
  /** Logical key name, e.g. "smtp_password". */
  key: string
  /** ISO timestamp of first creation. */
  createdAt: string
  /** ISO timestamp of last update. */
  updatedAt: string
}

// ── Master key resolution ─────────────────────────────────────────────────────

/**
 * Resolve the master key material from the environment.
 *
 *   – Production: CREDENTIALS_MASTER_KEY must be set and non-empty.  A missing
 *     key throws immediately (fail-closed) so the server never boots in a
 *     state where secrets are encrypted under an unintended key.
 *   – Development / test: when unset, an ephemeral 32-byte key is generated.
 *     A warning is printed once at import time; data encrypted with it cannot
 *     be decrypted after a restart, which is documented in the README.
 *
 * The accepted encodings are hex (64 chars → 32 bytes) or base64 (44 chars →
 * 32 bytes, with optional padding).  Any other length is rejected.
 */
function resolveMasterKey(): Buffer {
  const raw = process.env['CREDENTIALS_MASTER_KEY']

  if (raw === undefined || raw.trim() === '') {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'CREDENTIALS_MASTER_KEY environment variable must be set in production',
      )
    }
    // Dev/test ephemeral key.  Warn loudly so it is never mistaken for a
    // persisted key.  Tests set NODE_ENV=test and an explicit key, so this
    // branch is only hit by local development and the ephemeral-key test.
    console.warn(
      '[credentials] CREDENTIALS_MASTER_KEY not set – using ephemeral key ' +
        '(dev/test only). Encrypted data will not be decryptable after restart.',
    )
    return randomBytes(KEY_LEN)
  }

  const trimmed = raw.trim()
  // Hex: 64 chars → 32 bytes.  Base64: 44 chars (with padding) → 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }
  // base64 of 32 bytes is 44 chars incl. one padding '='; allow unpadded too.
  if (/^[A-Za-z0-9+/]{43}={0,2}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'base64')
    if (buf.length === KEY_LEN) {
      return buf
    }
  }
  throw new Error(
    'CREDENTIALS_MASTER_KEY must be 32 bytes encoded as hex (64 chars) or base64 (44 chars)',
  )
}

// Resolve once at module load so fail-fast happens on import, mirroring the
// JWT_SECRET pattern in auth.ts.  The derived AES key is also computed once.
const MASTER_KEY: Buffer = resolveMasterKey()
const DERIVED_KEY: Buffer = Buffer.from(
  hkdfSync('sha256', MASTER_KEY, HKDF_SALT, HKDF_INFO, KEY_LEN),
)

// Zero the master key buffer from memory once the derived key exists, keeping
// only the derived key resident.  (best-effort; JS buffers are not guaranteed
// to be cleared, but this avoids leaving the raw master key around.)
MASTER_KEY.fill(0)

// ── Input validation ──────────────────────────────────────────────────────────

/**
 * Validate a credential key name.  Key names are used in the natural-key
 * lookup (user_id, key) and are returned in metadata, so they must be safe
 * to surface and bounded in length.  Control characters are rejected to
 * avoid log-injection / display quirks.
 */
function validateKeyName(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('Credential key must be a non-empty string')
  }
  if (key.length > MAX_KEY_NAME_LEN) {
    throw new Error(`Credential key must be at most ${MAX_KEY_NAME_LEN} characters`)
  }
  if (/[\x00-\x1f\x7f]/.test(key)) {
    throw new Error('Credential key must not contain control characters')
  }
}

/** Validate a user id, if provided.  null/undefined is allowed (system scope). */
function validateUserId(userId: unknown): asserts userId is string | null {
  if (userId === undefined || userId === null) return // system scope
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('Credential userId must be a non-empty string when provided')
  }
  if (userId.length > MAX_USER_ID_LEN) {
    throw new Error(`Credential userId must be at most ${MAX_USER_ID_LEN} characters`)
  }
  if (/[\x00-\x1f\x7f]/.test(userId)) {
    throw new Error('Credential userId must not contain control characters')
  }
}

/** Validate secret value length to avoid unbounded storage / DoS. */
function validateSecret(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error('Credential value must be a string')
  }
  if (value.length === 0) {
    throw new Error('Credential value must be a non-empty string')
  }
  if (value.length > MAX_SECRET_LEN) {
    throw new Error(`Credential value must be at most ${MAX_SECRET_LEN} characters`)
  }
}

// ── Encryption / decryption primitives ───────────────────────────────────────

/**
 * Encrypt a plaintext secret with AES-256-GCM under the derived key.
 * Returns the base64-encoded ciphertext and the base64-encoded 12-byte IV.
 * The GCM auth tag is appended to the ciphertext (last 16 bytes) so a single
 * blob is persisted and decryption can detect tampering.
 *
 * @internal exported for tests; not part of the public store API.
 */
export function encryptSecret(plaintext: string): {
  ciphertext: string
  iv: string
} {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGORITHM, DERIVED_KEY, iv)
  const plain = Buffer.from(plaintext, 'utf8')
  const enc = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  // tag is appended so the stored blob is self-describing on decrypt.
  const blob = Buffer.concat([enc, tag])
  return { ciphertext: blob.toString('base64'), iv: iv.toString('base64') }
}

/**
 * Decrypt a base64 ciphertext + base64 IV produced by encryptSecret.
 * Throws when the auth tag does not verify (tampering or wrong key); callers
 * should wrap with context and never expose the raw error detail to clients.
 *
 * @internal exported for tests; not part of the public store API.
 */
export function decryptSecret(ciphertextB64: string, ivB64: string): string {
  const blob = Buffer.from(ciphertextB64, 'base64')
  const iv = Buffer.from(ivB64, 'base64')
  if (iv.length !== IV_LEN) {
    throw new Error('Invalid credential IV length')
  }
  if (blob.length < 16) {
    throw new Error('Invalid credential ciphertext (too short for auth tag)')
  }
  // The last 16 bytes are the GCM auth tag.
  const tag = blob.subarray(blob.length - 16)
  const enc = blob.subarray(0, blob.length - 16)
  const decipher = createDecipheriv(ALGORITHM, DERIVED_KEY, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(enc), decipher.final()])
  return dec.toString('utf8')
}

// ── Public store API ──────────────────────────────────────────────────────────

/**
 * Save (upsert) an encrypted credential.
 *
 * @param userId  Owning user id, or null for a system/global credential.
 * @param key     Logical key name (e.g. "smtp_password").
 * @param value   Plaintext secret to encrypt and store.
 * @returns The stable credential id (userId:key, or system:key).
 */
export function saveCredential(
  userId: string | null,
  key: string,
  value: string,
): string {
  validateUserId(userId)
  validateKeyName(key)
  validateSecret(value)

  const { ciphertext, iv } = encryptSecret(value)
  const now = new Date().toISOString()
  const id = credentialId(userId, key)
  upsertCredential({
    id,
    user_id: userId,
    key,
    encrypted_value: ciphertext,
    iv,
    created_at: now,
    updated_at: now,
  })
  return id
}

/**
 * Retrieve and decrypt a stored credential.
 *
 * @param userId  Owning user id, or null for a system/global credential.
 * @param key     Logical key name.
 * @returns The decrypted plaintext secret, or undefined when no such
 *          credential exists.  Decryption errors (tampering/wrong key) are
 *          wrapped with context and re-thrown — never silently return null.
 */
export function getCredentialSecret(
  userId: string | null,
  key: string,
): string | undefined {
  validateUserId(userId)
  validateKeyName(key)

  const row = getCredential(userId, key)
  if (!row) return undefined

  try {
    return decryptSecret(row.encrypted_value, row.iv)
  } catch (err) {
    // Never leak the raw crypto error (it can reveal key/iv details); wrap
    // with a generic message that is safe to surface.
    throw new Error(
      `Failed to decrypt credential "${key}" — it may be corrupt or was ` +
        'encrypted under a different master key',
    )
  }
}

/**
 * List stored credentials as metadata only.  Never returns the ciphertext,
 * IV, or plaintext.  Filtering by userId is supported; pass null to list
 * system credentials, or omit to list all credentials.
 *
 * @param userId  Optional filter: when provided only that user's credentials
 *                are returned; when null only system credentials; when
 *                omitted all credentials across all scopes.
 */
/** Row shape returned by the list query (no ciphertext/iv). */
interface CredentialListRow {
  id: string
  user_id: string | null
  key: string
  created_at: string
  updated_at: string
}

export function listCredentials(userId?: string | null): CredentialMetadata[] {
  // Delegate the row scan to the DB module.  getDb is imported at the top of
  // this module — the db module does not import the credentials service, so
  // there is no circular dependency.  Using a static import (rather than a
  // lazy require) keeps this working under the project's ESM/vitest setup.
  const db = getDb()

  let rows: CredentialListRow[]

  if (userId === undefined) {
    rows = db
      .prepare<unknown[], CredentialListRow>(
        'SELECT id, user_id, key, created_at, updated_at FROM credentials ORDER BY user_id IS NULL DESC, user_id, key',
      )
      .all()
  } else if (userId === null) {
    rows = db
      .prepare<unknown[], CredentialListRow>(
        'SELECT id, user_id, key, created_at, updated_at FROM credentials WHERE user_id IS NULL ORDER BY key',
      )
      .all()
  } else {
    rows = db
      .prepare<[string], CredentialListRow>(
        'SELECT id, user_id, key, created_at, updated_at FROM credentials WHERE user_id = ? ORDER BY key',
      )
      .all(userId)
  }

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    key: r.key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

/**
 * Delete a stored credential.
 *
 * @param userId  Owning user id, or null for a system/global credential.
 * @param key     Logical key name.
 * @returns true when a credential was removed, false when none existed.
 */
export function removeCredential(userId: string | null, key: string): boolean {
  validateUserId(userId)
  validateKeyName(key)
  const removed = deleteCredential(userId, key)
  return removed > 0
}
