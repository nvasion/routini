/**
 * Tests for the SSRF-safe DNS resolver used by the dashboard handler.
 *
 * Every test injects a fake lookup so no real DNS traffic is generated.
 */

import { describe, expect, it } from 'vitest'
import {
  UnsafeHostError,
  resolveHostnameSafe,
  type LookupFn,
} from '../server/src/tasks/daily/dns.js'

/** Build a `LookupFn` that returns the given synthetic answers. */
function lookupReturning(
  answers: ReadonlyArray<{ address: string; family: number }>,
): LookupFn {
  return async () => answers
}

/** Build a `LookupFn` that rejects with the given error. */
function lookupRejecting(err: Error): LookupFn {
  return async () => {
    throw err
  }
}

describe('resolveHostnameSafe', () => {
  it('accepts a public A record', async () => {
    const result = await resolveHostnameSafe(
      'example.com',
      lookupReturning([{ address: '93.184.216.34', family: 4 }]),
    )
    expect(result).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('accepts a public AAAA record', async () => {
    const result = await resolveHostnameSafe(
      'example.com',
      lookupReturning([{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]),
    )
    expect(result).toEqual([{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }])
  })

  it('rejects a hostname that resolves to loopback (DNS rebind guard)', async () => {
    await expect(
      resolveHostnameSafe(
        'evil.example',
        lookupReturning([{ address: '127.0.0.1', family: 4 }]),
      ),
    ).rejects.toBeInstanceOf(UnsafeHostError)
  })

  it('rejects when *any* answer is private (mixed public+private set)', async () => {
    await expect(
      resolveHostnameSafe(
        'rebind.example',
        lookupReturning([
          { address: '1.2.3.4', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_HOST' })
  })

  it('rejects RFC1918 ranges', async () => {
    for (const addr of ['10.0.0.1', '172.16.0.1', '192.168.1.1']) {
      await expect(
        resolveHostnameSafe(
          'private.example',
          lookupReturning([{ address: addr, family: 4 }]),
        ),
      ).rejects.toMatchObject({ code: 'UNSAFE_HOST' })
    }
  })

  it('rejects link-local IPv4 (cloud metadata range)', async () => {
    await expect(
      resolveHostnameSafe(
        'metadata.example',
        lookupReturning([{ address: '169.254.169.254', family: 4 }]),
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_HOST' })
  })

  it('rejects IPv6 loopback', async () => {
    await expect(
      resolveHostnameSafe(
        'v6loopback.example',
        lookupReturning([{ address: '::1', family: 6 }]),
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_HOST' })
  })

  it('rejects hostnames that already fail the name-based check without a lookup', async () => {
    let called = false
    const lookup: LookupFn = async () => {
      called = true
      return [{ address: '1.2.3.4', family: 4 }]
    }
    await expect(resolveHostnameSafe('localhost', lookup)).rejects.toMatchObject({
      code: 'UNSAFE_HOST',
    })
    expect(called).toBe(false)
  })

  it('short-circuits IP literals through the SSRF gate (no DNS)', async () => {
    // Never call the lookup.
    let called = false
    const lookup: LookupFn = async () => {
      called = true
      return []
    }
    const result = await resolveHostnameSafe('8.8.8.8', lookup)
    expect(result).toEqual([{ address: '8.8.8.8', family: 4 }])
    expect(called).toBe(false)
  })

  it('rejects a literal loopback IP passed directly', async () => {
    await expect(resolveHostnameSafe('127.0.0.1')).rejects.toMatchObject({
      code: 'UNSAFE_HOST',
    })
  })

  it('wraps DNS lookup errors as DNS_LOOKUP_FAILED', async () => {
    await expect(
      resolveHostnameSafe(
        'unresolvable.example',
        lookupRejecting(new Error('ENOTFOUND')),
      ),
    ).rejects.toMatchObject({ code: 'DNS_LOOKUP_FAILED' })
  })

  it('reports NO_ADDRESSES when the resolver returns an empty answer', async () => {
    await expect(
      resolveHostnameSafe('void.example', lookupReturning([])),
    ).rejects.toMatchObject({ code: 'NO_ADDRESSES' })
  })

  it('rejects empty hostname input', async () => {
    await expect(resolveHostnameSafe('')).rejects.toBeInstanceOf(UnsafeHostError)
  })
})
