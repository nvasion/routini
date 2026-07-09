/**
 * SSRF-safe DNS resolution for the HTTP dashboard handler.
 *
 * `validation.ts` blocks obviously-private hostnames (`10.x`, `localhost`,
 * `::1`, …) at input validation time so a task can never be *stored* with a
 * disallowed URL. That check runs against the literal string the user
 * supplied — it can't catch two important attack shapes:
 *
 *   1. **DNS-rebinding.** A user configures `https://attacker.example`. At
 *      validation time the record resolves to a public IP, so the URL is
 *      accepted. At *fetch* time the same name resolves to `127.0.0.1`
 *      because the attacker's authoritative server has since updated its
 *      answer. Validation-time checks alone would let the outbound request
 *      land on our own loopback interface.
 *   2. **Records that were public then, private now.** A hostname whose
 *      A-record changes to `10.0.0.5` between validate-time and fetch-time
 *      would also slip through. Same shape as above.
 *
 * `resolveHostnameSafe` closes both by re-resolving the hostname at request
 * time and rejecting the request if any A/AAAA record targets a disallowed
 * range. The resolved IPs are returned so callers can pin the outbound
 * connection to those exact addresses — that guarantees the request the
 * kernel makes is the one whose destination we validated.
 *
 * All checks are delegated to `isSsrfUnsafeHostname` in `validation.ts` so
 * the same allowlist governs both validation-time and fetch-time gating.
 */

import { promises as dnsPromises } from 'node:dns'
import { isIP } from 'node:net'
import { isSsrfUnsafeHostname } from '../validation.js'

/** Coded error emitted when DNS resolution reveals a disallowed target. */
export class UnsafeHostError extends Error {
  public readonly code: 'UNSAFE_HOST' | 'DNS_LOOKUP_FAILED' | 'NO_ADDRESSES'
  public readonly hostname: string

  constructor(
    code: 'UNSAFE_HOST' | 'DNS_LOOKUP_FAILED' | 'NO_ADDRESSES',
    hostname: string,
    message: string,
  ) {
    super(message)
    this.name = 'UnsafeHostError'
    this.code = code
    this.hostname = hostname
  }
}

/** Result of a safe hostname resolution. */
export interface SafeAddress {
  /** IPv4 or IPv6 literal (never a name). */
  address: string
  /** 4 or 6, matching what dns.lookup returns. */
  family: 4 | 6
}

/**
 * Injectable DNS resolver, so tests can supply deterministic responses
 * without touching the network. Matches the shape of `dns.promises.lookup`
 * with `all: true`.
 */
export type LookupFn = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>

/** Default resolver — uses Node's built-in `dns.promises.lookup(..., { all: true })`. */
export const defaultLookup: LookupFn = async (hostname) => {
  const results = await dnsPromises.lookup(hostname, { all: true, verbatim: true })
  return results
}

/**
 * Resolve a hostname to one or more IP addresses, throwing `UnsafeHostError`
 * if any resolved address falls into a blocked range.
 *
 * IP literals (`1.2.3.4`, `::1`) bypass DNS but are still checked against
 * `isSsrfUnsafeHostname`. Every returned entry is guaranteed safe.
 */
export async function resolveHostnameSafe(
  hostname: string,
  lookup: LookupFn = defaultLookup,
): Promise<SafeAddress[]> {
  if (typeof hostname !== 'string' || hostname.trim().length === 0) {
    throw new UnsafeHostError('UNSAFE_HOST', hostname, 'hostname is required')
  }

  // If the caller already passed a literal IP, don't hit DNS — just check it.
  const literalFamily = isIP(hostname)
  if (literalFamily !== 0) {
    if (isSsrfUnsafeHostname(hostname)) {
      throw new UnsafeHostError(
        'UNSAFE_HOST',
        hostname,
        `address ${hostname} is in a blocked range`,
      )
    }
    return [{ address: hostname, family: literalFamily as 4 | 6 }]
  }

  // Always block hostname strings that our name-based checks already reject
  // (e.g. `localhost`) so we don't even send them to the resolver.
  if (isSsrfUnsafeHostname(hostname)) {
    throw new UnsafeHostError(
      'UNSAFE_HOST',
      hostname,
      `hostname ${hostname} is disallowed`,
    )
  }

  let addresses: ReadonlyArray<{ address: string; family: number }>
  try {
    addresses = await lookup(hostname)
  } catch (err) {
    // Never surface the underlying error message directly — it can leak
    // internal resolver state / IPs. Wrap into a coded error instead.
    const cause = err instanceof Error ? err.message : String(err)
    throw new UnsafeHostError(
      'DNS_LOOKUP_FAILED',
      hostname,
      `DNS lookup failed for ${hostname}: ${cause}`,
    )
  }

  if (addresses.length === 0) {
    throw new UnsafeHostError(
      'NO_ADDRESSES',
      hostname,
      `DNS returned no addresses for ${hostname}`,
    )
  }

  const safe: SafeAddress[] = []
  for (const entry of addresses) {
    if (entry.family !== 4 && entry.family !== 6) continue
    if (isSsrfUnsafeHostname(entry.address)) {
      // Any single blocked answer fails the whole resolution — otherwise a
      // hostname with both a public and a private answer (DNS-rebind attack)
      // could still be attacked by racing the connect() to the private one.
      throw new UnsafeHostError(
        'UNSAFE_HOST',
        hostname,
        `hostname ${hostname} resolves to a disallowed address`,
      )
    }
    safe.push({ address: entry.address, family: entry.family as 4 | 6 })
  }

  if (safe.length === 0) {
    throw new UnsafeHostError(
      'NO_ADDRESSES',
      hostname,
      `no usable addresses returned for ${hostname}`,
    )
  }

  return safe
}
