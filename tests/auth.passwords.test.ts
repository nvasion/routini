import { describe, expect, it } from 'vitest'
import { PasswordError, hashPassword, verifyPassword } from '../server/src/auth/passwords.js'

describe('auth/passwords', () => {
  it('produces a verifiable hash', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('secret')
    expect(await verifyPassword('SECRET', hash)).toBe(false)
    expect(await verifyPassword('secret ', hash)).toBe(false)
  })

  it('produces a different hash each call (salt is random)', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')
    expect(a).not.toBe(b)
  })

  it('returns false on malformed hashes rather than throwing', async () => {
    expect(await verifyPassword('any', '')).toBe(false)
    expect(await verifyPassword('any', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('any', 'scrypt$1$1$1$notsalt$nothash')).toBe(false)
    expect(await verifyPassword('any', 'scrypt$$$$$')).toBe(false)
  })

  it('rejects an empty password on hash or verify', async () => {
    await expect(hashPassword('')).rejects.toBeInstanceOf(PasswordError)
    // verify still requires a real password; empty is rejected before comparison
    const hash = await hashPassword('x')
    await expect(verifyPassword('', hash)).rejects.toBeInstanceOf(PasswordError)
  })

  it('refuses maliciously oversized scrypt parameters', async () => {
    // A hash claiming N = 2^30 must not be executed — it would exhaust memory.
    const dangerous = `scrypt$${1 << 30}$8$1$00$00`
    expect(await verifyPassword('anything', dangerous)).toBe(false)
  })
})
