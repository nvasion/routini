/**
 * AES-256-GCM helper for the AI settings API-key at-rest encryption.
 *
 * Design goals
 * ────────────
 * - **Authenticated encryption.** GCM's 16-byte tag detects tampering; the
 *   `decrypt` path throws on any modification of the ciphertext or IV rather
 *   than silently returning garbage.
 * - **Per-record IVs.** Each call generates a fresh 12-byte IV from
 *   `crypto.randomBytes` so the same plaintext produces a different
 *   ciphertext each time. Reusing an IV under a fixed key breaks GCM entirely.
 * - **Compact wire format.** IV || tag || ciphertext concatenated, then
 *   base64. A single opaque string is easier to move between the in-memory
 *   store today and a database column tomorrow than a structured record.
 * - **Key material is caller-owned.** The store instantiates `Encryptor`
 *   with a 32-byte key. Callers source keys from an env var / KMS — this
 *   module never touches `process.env` so it stays trivially unit-testable.
 *
 * SECURITY NOTE — key rotation:
 * This module encrypts and decrypts under a single key. Rotating the key
 * requires re-encrypting all existing records (out of scope for the MVP).
 * A production deployment should tag each ciphertext with a key ID so
 * multiple generations can coexist during a rotation window.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // GCM standard nonce length (bytes)
const TAG_LENGTH = 16 // GCM authentication tag length (bytes)
export const AI_ENCRYPTION_KEY_BYTES = 32 // 256-bit key

export class EncryptionError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = 'EncryptionError'
    if (options.cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}

/**
 * AES-256-GCM encrypt / decrypt bound to a single 32-byte key.
 *
 * Kept as a class rather than free functions so the key material lives in a
 * closed-over instance field instead of being passed on every call site — that
 * makes it harder to accidentally log or serialize the key.
 */
export class Encryptor {
  private readonly key: Buffer

  constructor(key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length !== AI_ENCRYPTION_KEY_BYTES) {
      throw new EncryptionError(
        `encryption key must be exactly ${AI_ENCRYPTION_KEY_BYTES} bytes`,
      )
    }
    // Copy so a caller who mutates their buffer post-construction cannot
    // change the key we operate under.
    this.key = Buffer.from(key)
  }

  /**
   * Encrypt a UTF-8 plaintext. Returns a base64 string containing
   * `iv || tag || ciphertext`.
   */
  encrypt(plaintext: string): string {
    if (typeof plaintext !== 'string') {
      throw new EncryptionError('plaintext must be a string')
    }
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    if (tag.length !== TAG_LENGTH) {
      // Should be unreachable — GCM always produces a 16-byte tag by default,
      // but we validate defensively so a future implementation change surfaces
      // as a clean error instead of a wire-format bug.
      throw new EncryptionError('unexpected authentication tag length')
    }
    return Buffer.concat([iv, tag, ciphertext]).toString('base64')
  }

  /**
   * Decrypt a payload produced by {@link Encryptor.encrypt}. Throws
   * {@link EncryptionError} on any tampering, corruption, or key mismatch.
   */
  decrypt(payload: string): string {
    if (typeof payload !== 'string' || payload.length === 0) {
      throw new EncryptionError('ciphertext payload must be a non-empty string')
    }
    let buffer: Buffer
    try {
      buffer = Buffer.from(payload, 'base64')
    } catch (err) {
      throw new EncryptionError('ciphertext payload is not valid base64', { cause: err })
    }
    // The payload must contain at least the IV and the auth tag. A zero-byte
    // ciphertext body is legitimate (it corresponds to an empty plaintext),
    // so we only reject payloads that cannot even hold the header fields.
    if (buffer.length < IV_LENGTH + TAG_LENGTH) {
      throw new EncryptionError('ciphertext payload is truncated')
    }
    const iv = buffer.subarray(0, IV_LENGTH)
    const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
    const ciphertext = buffer.subarray(IV_LENGTH + TAG_LENGTH)
    const decipher = createDecipheriv(ALGORITHM, this.key, iv)
    decipher.setAuthTag(tag)
    try {
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ])
      return plaintext.toString('utf8')
    } catch (err) {
      // Auth-tag mismatch, corruption, or wrong key. Do NOT include the
      // underlying message — it can leak information about the ciphertext.
      throw new EncryptionError('failed to decrypt payload (tampered or wrong key)', {
        cause: err,
      })
    }
  }
}

/**
 * Generate a fresh random 32-byte encryption key. Used as an in-process
 * fallback when no key is provided via the environment. Callers that
 * persist encrypted records MUST supply a stable key sourced from a KMS
 * or dedicated secret manager — a per-process random key means every
 * restart invalidates all stored ciphertext.
 */
export function generateEncryptionKey(): Buffer {
  return randomBytes(AI_ENCRYPTION_KEY_BYTES)
}

/**
 * Parse a base64-encoded 32-byte encryption key from a string. Returns the
 * key buffer on success, or throws {@link EncryptionError} on any format
 * problem — length mismatch, non-base64 input, etc. Kept separate from the
 * `Encryptor` constructor so environment parsing has a single seam that
 * tests can exercise without instantiating a cipher.
 */
export function parseEncryptionKey(raw: string): Buffer {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new EncryptionError('encryption key must be a non-empty base64 string')
  }
  let buffer: Buffer
  try {
    buffer = Buffer.from(raw, 'base64')
  } catch (err) {
    throw new EncryptionError('encryption key is not valid base64', { cause: err })
  }
  if (buffer.length !== AI_ENCRYPTION_KEY_BYTES) {
    throw new EncryptionError(
      `encryption key must decode to exactly ${AI_ENCRYPTION_KEY_BYTES} bytes` +
        ` (got ${buffer.length})`,
    )
  }
  return buffer
}
