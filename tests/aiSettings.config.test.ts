/**
 * Unit tests for `resolveAiEncryptor` — the env-driven bootstrap that
 * decides whether to source the encryption key from the environment or
 * fall back to an ephemeral in-process key.
 *
 * The intent is to lock in the fail-secure behavior:
 *  - Production without an explicit key: throw.
 *  - Production with a malformed key: throw.
 *  - Non-production without an explicit key: warn and fall back.
 *  - Any environment with a valid key: use it silently.
 */

import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  AI_ENCRYPTION_KEY_BYTES,
  AI_ENCRYPTION_KEY_ENV,
  EncryptionError,
  resolveAiEncryptor,
} from '../server/src/aiSettings/index.js'

function validKey(): string {
  return randomBytes(AI_ENCRYPTION_KEY_BYTES).toString('base64')
}

describe('resolveAiEncryptor', () => {
  it('throws in production when the key env var is missing', () => {
    expect(() =>
      resolveAiEncryptor({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(EncryptionError)
  })

  it('throws in production when the key is malformed', () => {
    expect(() =>
      resolveAiEncryptor({
        NODE_ENV: 'production',
        [AI_ENCRYPTION_KEY_ENV]: 'not-a-key',
      } as NodeJS.ProcessEnv),
    ).toThrow(EncryptionError)
  })

  it('throws in production for a wrong-length key', () => {
    // 16 bytes instead of 32 — decodes cleanly but wrong size.
    const shortKey = randomBytes(16).toString('base64')
    expect(() =>
      resolveAiEncryptor({
        NODE_ENV: 'production',
        [AI_ENCRYPTION_KEY_ENV]: shortKey,
      } as NodeJS.ProcessEnv),
    ).toThrow(EncryptionError)
  })

  it('returns a working encryptor when the env key is valid in production', () => {
    const key = validKey()
    const enc = resolveAiEncryptor(
      { NODE_ENV: 'production', [AI_ENCRYPTION_KEY_ENV]: key } as NodeJS.ProcessEnv,
      { warn: vi.fn() },
    )
    // Sanity check: round-trip works.
    expect(enc.decrypt(enc.encrypt('hi'))).toBe('hi')
  })

  it('warns and returns an ephemeral encryptor when the key is missing in dev', () => {
    const warn = vi.fn()
    const enc = resolveAiEncryptor(
      { NODE_ENV: 'development' } as NodeJS.ProcessEnv,
      { warn },
    )
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain(AI_ENCRYPTION_KEY_ENV)
    expect(enc.decrypt(enc.encrypt('x'))).toBe('x')
  })

  it('does not warn when a valid key is provided in dev', () => {
    const warn = vi.fn()
    resolveAiEncryptor(
      { NODE_ENV: 'development', [AI_ENCRYPTION_KEY_ENV]: validKey() } as NodeJS.ProcessEnv,
      { warn },
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('treats whitespace-only key as unset', () => {
    const warn = vi.fn()
    resolveAiEncryptor(
      { NODE_ENV: 'development', [AI_ENCRYPTION_KEY_ENV]: '   ' } as NodeJS.ProcessEnv,
      { warn },
    )
    expect(warn).toHaveBeenCalled()
  })
})
