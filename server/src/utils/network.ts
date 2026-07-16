/**
 * Network utility helpers for SSRF (Server-Side Request Forgery) mitigation.
 *
 * These helpers are used by the SSH, IMAP, and HTTP daily-task services to
 * prevent tasks from connecting to private or loopback addresses — which could
 * be abused to probe internal services the server has privileged access to.
 *
 * Defense-in-depth strategy:
 *   1. `isSsrfSafeHostname` – fast, synchronous check against known private
 *      literal IP ranges and special hostnames.  Used as a first gate.
 *   2. `resolvedIpIsSsrfSafe` – DNS-resolves the hostname and re-checks the
 *      returned address.  Used by HTTP fetch to mitigate DNS rebinding.
 *
 * Limitations: DNS-resolution checks are subject to TOCTOU races (the IP
 * could change between the lookup and the actual connection).  Production
 * deployments should additionally enforce egress filtering at the network level.
 */

import { lookup } from 'node:dns/promises'

// ── Private-range detectors ───────────────────────────────────────────────────

/**
 * Returns true when `addr` is an IPv4 address in a private, loopback, or
 * otherwise non-routable range (RFC 1918, 5735, 6598, …).
 */
function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map(Number)
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = nums as [number, number, number, number]

  return (
    a === 0 ||            // 0.0.0.0/8  – "this" network
    a === 10 ||           // 10.0.0.0/8  – RFC 1918
    a === 127 ||          // 127.0.0.0/8 – loopback
    (a === 100 && b >= 64 && b <= 127) ||   // 100.64.0.0/10 – CGNAT RFC 6598
    (a === 169 && b === 254) ||             // 169.254.0.0/16 – link-local
    (a === 172 && b >= 16 && b <= 31) ||    // 172.16.0.0/12  – RFC 1918
    (a === 192 && b === 168) ||             // 192.168.0.0/16 – RFC 1918
    a === 255                               // broadcast
  )
}

/**
 * Returns true when `addr` is an IPv6 address in a loopback, unspecified,
 * link-local, or Unique Local Address (ULA) range.
 */
function isPrivateIpv6(addr: string): boolean {
  const lower = addr.toLowerCase()
  return (
    lower === '::1' ||            // loopback
    lower === '::' ||             // unspecified
    lower.startsWith('fe80:') ||  // link-local
    lower.startsWith('fc') ||     // ULA fc00::/7
    lower.startsWith('fd')        // ULA fc00::/7
  )
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Synchronous hostname check.  Returns `false` for:
 *   – "localhost" and known loopback aliases
 *   – ".local" mDNS domains
 *   – IPv4 literals in private/loopback/non-routable ranges
 *   – IPv6 literals in loopback/ULA/link-local ranges
 *
 * Returns `true` for all other values (including public hostnames that may
 * still resolve to private IPs — use `resolvedIpIsSsrfSafe` for those).
 */
export function isSsrfSafeHostname(hostname: string): boolean {
  if (!hostname || typeof hostname !== 'string') return false
  const lower = hostname.toLowerCase().trim()
  if (!lower) return false

  // Well-known special hostnames
  if (lower === 'localhost' || lower === 'ip6-localhost' || lower === 'broadcasthost') {
    return false
  }

  // mDNS / Bonjour
  if (lower.endsWith('.local')) return false

  // IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower)) {
    return !isPrivateIpv4(lower)
  }

  // IPv6 literal — may appear bare or in square brackets
  const ipv6Candidate = lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower
  if (ipv6Candidate.includes(':')) {
    return !isPrivateIpv6(ipv6Candidate)
  }

  return true
}

/**
 * Async SSRF guard: resolves `hostname` via DNS and checks the returned address.
 *
 * Returns `false` (unsafe) when:
 *   – `isSsrfSafeHostname` already rejects the value.
 *   – DNS resolution fails (host does not exist).
 *   – The resolved address is in a private/loopback range.
 *
 * Returns `true` only when the hostname resolves to a routable, non-private IP.
 */
export async function resolvedIpIsSsrfSafe(hostname: string): Promise<boolean> {
  if (!isSsrfSafeHostname(hostname)) return false

  try {
    const { address, family } = await lookup(hostname)
    return family === 4 ? !isPrivateIpv4(address) : !isPrivateIpv6(address)
  } catch {
    // DNS failure — host is unreachable or doesn't exist; treat as unsafe to
    // give a uniform "cannot connect" result rather than leaking whether the
    // host exists on the internal network.
    return false
  }
}
