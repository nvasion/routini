// ─────────────────────────────────────────────────────────────────────────────
// Secret encryption (AES-256-GCM)
//
// The AES key is derived from CREDENTIALS_MASTER_KEY with HKDF-SHA256, the same
// derivation the pre-Phase-0 credential store used. Each record gets a fresh
// 96-bit IV; the 16-byte auth tag is appended to the ciphertext.
//
// New in Phase 0: ciphertexts are bound to their (org, key) location as GCM
// additional authenticated data, so a row copied to another org or key fails
// to decrypt instead of leaking.
// ─────────────────────────────────────────────────────────────────────────────

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm' as const
const KEY_LEN = 32
const IV_LEN = 12
const TAG_LEN = 16
const HKDF_SALT = Buffer.from('routini-credential-store-v1', 'utf8')
const HKDF_INFO = Buffer.from('aes-256-gcm-credentials', 'utf8')

export interface SealedSecret {
  ciphertext: string // base64(ciphertext || tag)
  iv: string // base64
}

export interface SecretBox {
  seal(plaintext: string, aad: string): SealedSecret
  open(sealed: SealedSecret, aad: string): string
}

/** Parses a 32-byte key given as 64 hex chars or base64. */
export function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')
  if (/^[A-Za-z0-9+/]{43}={0,2}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'base64')
    if (buf.length === KEY_LEN) return buf
  }
  throw new Error('CREDENTIALS_MASTER_KEY must be 32 bytes encoded as hex (64 chars) or base64 (44 chars)')
}

/**
 * Creates a SecretBox. With no master key (allowed outside production by
 * loadConfig), a random key is used and secrets do not survive a restart.
 */
export function createSecretBox(masterKey: string | undefined): SecretBox {
  let master: Buffer
  if (masterKey) {
    master = parseMasterKey(masterKey)
  } else {
    if (process.env['NODE_ENV'] !== 'test') {
      console.warn('[secrets] CREDENTIALS_MASTER_KEY not set – using an ephemeral key; stored secrets will not survive a restart.')
    }
    master = randomBytes(KEY_LEN)
  }
  const key = Buffer.from(hkdfSync('sha256', master, HKDF_SALT, HKDF_INFO, KEY_LEN))
  master.fill(0)

  return {
    seal(plaintext, aad) {
      const iv = randomBytes(IV_LEN)
      const cipher = createCipheriv(ALGORITHM, key, iv)
      cipher.setAAD(Buffer.from(aad, 'utf8'))
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return {
        ciphertext: Buffer.concat([enc, cipher.getAuthTag()]).toString('base64'),
        iv: iv.toString('base64'),
      }
    },
    open(sealed, aad) {
      const blob = Buffer.from(sealed.ciphertext, 'base64')
      const iv = Buffer.from(sealed.iv, 'base64')
      if (iv.length !== IV_LEN) throw new Error('Invalid secret IV length')
      if (blob.length < TAG_LEN) throw new Error('Invalid secret ciphertext')
      const decipher = createDecipheriv(ALGORITHM, key, iv)
      decipher.setAAD(Buffer.from(aad, 'utf8'))
      decipher.setAuthTag(blob.subarray(blob.length - TAG_LEN))
      return Buffer.concat([decipher.update(blob.subarray(0, blob.length - TAG_LEN)), decipher.final()]).toString('utf8')
    },
  }
}
