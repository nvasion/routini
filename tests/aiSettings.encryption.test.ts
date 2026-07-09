/**
 * Unit tests for the AI-settings AES-256-GCM helper.
 *
 * Covers the round-trip happy path, per-record IV uniqueness, tamper
 * detection on ciphertext + IV + tag, key rejection at construction time,
 * base64 parsing, and the shape of the ephemeral key generator.
 */

import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AI_ENCRYPTION_KEY_BYTES,
  Encryptor,
  EncryptionError,
  generateEncryptionKey,
  parseEncryptionKey,
} from '../server/src/aiSettings/encryption.js'

function key(): Buffer {
  return generateEncryptionKey()
}

describe('Encryptor', () => {
  it('round-trips a plaintext through encrypt/decrypt', () => {
    const enc = new Encryptor(key())
    const plaintext = 'sk-test-1234567890'
    const ciphertext = enc.encrypt(plaintext)
    expect(ciphertext).not.toContain(plaintext)
    expect(enc.decrypt(ciphertext)).toBe(plaintext)
  })

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    const enc = new Encryptor(key())
    const a = enc.encrypt('hello')
    const b = enc.encrypt('hello')
    expect(a).not.toBe(b)
    expect(enc.decrypt(a)).toBe(enc.decrypt(b))
  })

  it('detects ciphertext tampering (modified byte)', () => {
    const enc = new Encryptor(key())
    const ciphertext = enc.encrypt('secret')
    // Flip one bit in the ciphertext body (after IV+tag)
    const buffer = Buffer.from(ciphertext, 'base64')
    // The ciphertext body starts at byte 28 (12-byte IV + 16-byte tag).
    buffer[buffer.length - 1] = buffer[buffer.length - 1] ^ 0x01
    const tampered = buffer.toString('base64')
    expect(() => enc.decrypt(tampered)).toThrow(EncryptionError)
  })

  it('detects auth tag tampering', () => {
    const enc = new Encryptor(key())
    const ciphertext = enc.encrypt('secret')
    const buffer = Buffer.from(ciphertext, 'base64')
    // Flip a bit in the tag region (bytes 12..27)
    buffer[15] = buffer[15] ^ 0x01
    expect(() => enc.decrypt(buffer.toString('base64'))).toThrow(EncryptionError)
  })

  it('detects IV tampering', () => {
    const enc = new Encryptor(key())
    const ciphertext = enc.encrypt('secret')
    const buffer = Buffer.from(ciphertext, 'base64')
    buffer[0] = buffer[0] ^ 0x01
    expect(() => enc.decrypt(buffer.toString('base64'))).toThrow(EncryptionError)
  })

  it('rejects decryption under a different key', () => {
    const encA = new Encryptor(key())
    const encB = new Encryptor(key())
    const ciphertext = encA.encrypt('secret')
    expect(() => encB.decrypt(ciphertext)).toThrow(EncryptionError)
  })

  it('rejects a truncated payload', () => {
    const enc = new Encryptor(key())
    // Under 28 bytes cannot possibly contain both IV and tag.
    const tooShort = Buffer.alloc(10).toString('base64')
    expect(() => enc.decrypt(tooShort)).toThrow(EncryptionError)
  })

  it('rejects an empty payload', () => {
    const enc = new Encryptor(key())
    expect(() => enc.decrypt('')).toThrow(EncryptionError)
  })

  it('rejects a non-string plaintext', () => {
    const enc = new Encryptor(key())
    expect(() => enc.encrypt(undefined as unknown as string)).toThrow(EncryptionError)
    expect(() => enc.encrypt(123 as unknown as string)).toThrow(EncryptionError)
  })

  it('rejects wrong-length keys at construction', () => {
    expect(() => new Encryptor(Buffer.alloc(16))).toThrow(EncryptionError)
    expect(() => new Encryptor(Buffer.alloc(64))).toThrow(EncryptionError)
    // Non-buffer inputs
    expect(() => new Encryptor('not a buffer' as unknown as Buffer)).toThrow(EncryptionError)
  })

  it('copies the key so caller mutation cannot change it', () => {
    const raw = randomBytes(AI_ENCRYPTION_KEY_BYTES)
    const enc = new Encryptor(raw)
    const ciphertext = enc.encrypt('secret')
    // Zero the caller's buffer after construction
    raw.fill(0)
    expect(enc.decrypt(ciphertext)).toBe('secret')
  })

  it('encrypts and decrypts empty strings', () => {
    const enc = new Encryptor(key())
    const c = enc.encrypt('')
    expect(enc.decrypt(c)).toBe('')
  })

  it('handles unicode content', () => {
    const enc = new Encryptor(key())
    const plaintext = '🔑 secret — «π» — 你好'
    expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext)
  })
})

describe('generateEncryptionKey', () => {
  it('returns a 32-byte buffer', () => {
    const k = generateEncryptionKey()
    expect(Buffer.isBuffer(k)).toBe(true)
    expect(k.length).toBe(AI_ENCRYPTION_KEY_BYTES)
  })

  it('returns a different key each call (probabilistic)', () => {
    const a = generateEncryptionKey()
    const b = generateEncryptionKey()
    expect(a.equals(b)).toBe(false)
  })
})

describe('parseEncryptionKey', () => {
  it('parses a valid base64-encoded 32-byte key', () => {
    const source = randomBytes(AI_ENCRYPTION_KEY_BYTES)
    const parsed = parseEncryptionKey(source.toString('base64'))
    expect(parsed.equals(source)).toBe(true)
  })

  it('rejects empty input', () => {
    expect(() => parseEncryptionKey('')).toThrow(EncryptionError)
  })

  it('rejects non-string input', () => {
    expect(() => parseEncryptionKey(undefined as unknown as string)).toThrow(EncryptionError)
  })

  it('rejects a wrong-length key', () => {
    const shortKey = randomBytes(16).toString('base64')
    expect(() => parseEncryptionKey(shortKey)).toThrow(EncryptionError)
    const longKey = randomBytes(64).toString('base64')
    expect(() => parseEncryptionKey(longKey)).toThrow(EncryptionError)
  })
})
