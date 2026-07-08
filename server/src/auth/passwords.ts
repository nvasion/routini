import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

/**
 * Password hashing helpers backed by node's built-in scrypt.
 *
 * We deliberately avoid bcryptjs — scrypt is memory-hard, ships with node, and
 * keeps the dependency graph small. Hashes are serialized as
 * `scrypt$<N>$<r>$<p>$<salt-hex>$<hash-hex>` so parameters can be rotated
 * without breaking existing users.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

const SCHEME = 'scrypt'
const KEY_LENGTH = 64
const SALT_LENGTH = 16

/*
 * scrypt cost parameters.
 *
 *   N (cost)      = 2^15 (32,768)
 *   r (block)     = 8
 *   p (parallel)  = 1
 *
 * These match the recommendations in RFC 7914 §2 for interactive login flows
 * (N ≥ 2^14 for a hash operation that stays under ~100 ms on modest hardware
 * while forcing an attacker's ASIC/GPU to allocate ~128 * N * r bytes ≈ 32 MiB
 * per guess). Raising N is the right knob if that ever becomes cheap; do NOT
 * lower it. The `verifyPassword` reader rejects hashes with N > 2^20 or
 * r > 32 or p > 16 so a malicious record can't force the process into a DoS.
 */
const DEFAULT_N = 1 << 15
const DEFAULT_R = 8
const DEFAULT_P = 1
// Node's default maxmem is 32 MiB; N=2^15 with r=8 needs ~64 MiB.
const MAX_MEM = 256 * 1024 * 1024

/** Upper bounds enforced on stored-hash parameters to prevent DoS on verify. */
const MAX_N = 1 << 20
const MAX_R = 32
const MAX_P = 16

export class PasswordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PasswordError'
  }
}

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new PasswordError('password must be a non-empty string')
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPassword(password)
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: MAX_MEM,
  })
  return `${SCHEME}$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString('hex')}$${derived.toString('hex')}`
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  assertPassword(password)
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    return false
  }

  const parts = storedHash.split('$')
  if (parts.length !== 6 || parts[0] !== SCHEME) {
    return false
  }

  const N = Number.parseInt(parts[1], 10)
  const r = Number.parseInt(parts[2], 10)
  const p = Number.parseInt(parts[3], 10)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false
  }
  // Guard against maliciously large parameters that could DoS the process.
  if (N > MAX_N || r > MAX_R || p > MAX_P) {
    return false
  }

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'hex')
    expected = Buffer.from(parts[5], 'hex')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) {
    return false
  }

  const derived = await scryptAsync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: MAX_MEM,
  })

  if (derived.length !== expected.length) {
    return false
  }
  return timingSafeEqual(derived, expected)
}
