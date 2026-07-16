/**
 * Unit tests for the SSRF network guard utilities.
 *
 * Coverage:
 *   – isSsrfSafeHostname: loopback, private IPv4 ranges, IPv6 loopback/ULA,
 *     .local domains, public hostnames and IPs
 *   – resolvedIpIsSsrfSafe: verified via mock DNS lookups (no real DNS calls)
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { isSsrfSafeHostname, resolvedIpIsSsrfSafe } from '../server/src/utils/network'

// ── Mock node:dns/promises ────────────────────────────────────────────────────
// We mock the DNS module so no real network calls occur in tests.

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

import { lookup } from 'node:dns/promises'

afterEach(() => {
  vi.clearAllMocks()
})

// ═════════════════════════════════════════════════════════════════════════════
// isSsrfSafeHostname
// ═════════════════════════════════════════════════════════════════════════════

describe('isSsrfSafeHostname', () => {
  // ── Loopback / special names ──────────────────────────────────────────────

  it('blocks "localhost"', () => {
    expect(isSsrfSafeHostname('localhost')).toBe(false)
  })

  it('blocks "LOCALHOST" (case-insensitive)', () => {
    expect(isSsrfSafeHostname('LOCALHOST')).toBe(false)
  })

  it('blocks "ip6-localhost"', () => {
    expect(isSsrfSafeHostname('ip6-localhost')).toBe(false)
  })

  it('blocks "broadcasthost"', () => {
    expect(isSsrfSafeHostname('broadcasthost')).toBe(false)
  })

  it('blocks empty string', () => {
    expect(isSsrfSafeHostname('')).toBe(false)
  })

  it('blocks null-like non-string', () => {
    expect(isSsrfSafeHostname(null as unknown as string)).toBe(false)
  })

  // ── .local mDNS ──────────────────────────────────────────────────────────

  it('blocks ".local" domains', () => {
    expect(isSsrfSafeHostname('myserver.local')).toBe(false)
  })

  it('blocks nested ".local" domains', () => {
    expect(isSsrfSafeHostname('db.internal.local')).toBe(false)
  })

  // ── IPv4 loopback ─────────────────────────────────────────────────────────

  it('blocks 127.0.0.1', () => {
    expect(isSsrfSafeHostname('127.0.0.1')).toBe(false)
  })

  it('blocks 127.0.0.2 (loopback range)', () => {
    expect(isSsrfSafeHostname('127.0.0.2')).toBe(false)
  })

  it('blocks 127.255.255.255', () => {
    expect(isSsrfSafeHostname('127.255.255.255')).toBe(false)
  })

  // ── IPv4 private ranges ───────────────────────────────────────────────────

  it('blocks 10.0.0.1 (RFC 1918)', () => {
    expect(isSsrfSafeHostname('10.0.0.1')).toBe(false)
  })

  it('blocks 10.255.255.255', () => {
    expect(isSsrfSafeHostname('10.255.255.255')).toBe(false)
  })

  it('blocks 172.16.0.1 (RFC 1918)', () => {
    expect(isSsrfSafeHostname('172.16.0.1')).toBe(false)
  })

  it('blocks 172.31.255.255 (RFC 1918)', () => {
    expect(isSsrfSafeHostname('172.31.255.255')).toBe(false)
  })

  it('allows 172.15.0.1 (just outside RFC 1918)', () => {
    expect(isSsrfSafeHostname('172.15.0.1')).toBe(true)
  })

  it('allows 172.32.0.1 (just outside RFC 1918)', () => {
    expect(isSsrfSafeHostname('172.32.0.1')).toBe(true)
  })

  it('blocks 192.168.0.1 (RFC 1918)', () => {
    expect(isSsrfSafeHostname('192.168.0.1')).toBe(false)
  })

  it('blocks 192.168.255.255', () => {
    expect(isSsrfSafeHostname('192.168.255.255')).toBe(false)
  })

  // ── IPv4 link-local and CGNAT ─────────────────────────────────────────────

  it('blocks 169.254.0.1 (link-local)', () => {
    expect(isSsrfSafeHostname('169.254.0.1')).toBe(false)
  })

  it('blocks 169.254.169.254 (AWS metadata)', () => {
    expect(isSsrfSafeHostname('169.254.169.254')).toBe(false)
  })

  it('blocks 100.64.0.1 (CGNAT RFC 6598)', () => {
    expect(isSsrfSafeHostname('100.64.0.1')).toBe(false)
  })

  it('blocks 100.127.255.255 (CGNAT)', () => {
    expect(isSsrfSafeHostname('100.127.255.255')).toBe(false)
  })

  it('allows 100.128.0.1 (outside CGNAT range)', () => {
    expect(isSsrfSafeHostname('100.128.0.1')).toBe(true)
  })

  // ── IPv4 – "this" network and broadcast ──────────────────────────────────

  it('blocks 0.0.0.0', () => {
    expect(isSsrfSafeHostname('0.0.0.0')).toBe(false)
  })

  it('blocks 255.255.255.255', () => {
    expect(isSsrfSafeHostname('255.255.255.255')).toBe(false)
  })

  // ── IPv6 ─────────────────────────────────────────────────────────────────

  it('blocks ::1 (IPv6 loopback)', () => {
    expect(isSsrfSafeHostname('::1')).toBe(false)
  })

  it('blocks :: (IPv6 unspecified)', () => {
    expect(isSsrfSafeHostname('::')).toBe(false)
  })

  it('blocks [::1] (bracketed IPv6)', () => {
    expect(isSsrfSafeHostname('[::1]')).toBe(false)
  })

  it('blocks fe80::1 (IPv6 link-local)', () => {
    expect(isSsrfSafeHostname('fe80::1')).toBe(false)
  })

  it('blocks fc00::1 (IPv6 ULA)', () => {
    expect(isSsrfSafeHostname('fc00::1')).toBe(false)
  })

  it('blocks fd00::1 (IPv6 ULA)', () => {
    expect(isSsrfSafeHostname('fd00::1')).toBe(false)
  })

  // ── Public / allowed ─────────────────────────────────────────────────────

  it('allows example.com', () => {
    expect(isSsrfSafeHostname('example.com')).toBe(true)
  })

  it('allows api.github.com', () => {
    expect(isSsrfSafeHostname('api.github.com')).toBe(true)
  })

  it('allows 8.8.8.8 (Google DNS)', () => {
    expect(isSsrfSafeHostname('8.8.8.8')).toBe(true)
  })

  it('allows 1.1.1.1 (Cloudflare DNS)', () => {
    expect(isSsrfSafeHostname('1.1.1.1')).toBe(true)
  })

  it('allows 203.0.113.1 (TEST-NET, treated as public)', () => {
    // TEST-NET is not private per RFC 1918; this guard allows it
    expect(isSsrfSafeHostname('203.0.113.1')).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// resolvedIpIsSsrfSafe
// ═════════════════════════════════════════════════════════════════════════════

describe('resolvedIpIsSsrfSafe', () => {
  it('returns false immediately for localhost (caught by hostname check)', async () => {
    const result = await resolvedIpIsSsrfSafe('localhost')
    expect(result).toBe(false)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('resolves the hostname via DNS for public names', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '93.184.216.34', family: 4 } as never)
    const result = await resolvedIpIsSsrfSafe('example.com')
    expect(result).toBe(true)
    expect(lookup).toHaveBeenCalledWith('example.com')
  })

  it('returns false when DNS resolves to a private IPv4 address', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '10.0.0.1', family: 4 } as never)
    const result = await resolvedIpIsSsrfSafe('internal.example.com')
    expect(result).toBe(false)
  })

  it('returns false when DNS resolves to 127.x.x.x', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '127.0.0.1', family: 4 } as never)
    const result = await resolvedIpIsSsrfSafe('sneaky.example.com')
    expect(result).toBe(false)
  })

  it('returns false when DNS resolves to 192.168.x.x', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '192.168.1.5', family: 4 } as never)
    const result = await resolvedIpIsSsrfSafe('evil.example.com')
    expect(result).toBe(false)
  })

  it('returns false when DNS resolves to IPv6 loopback ::1', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '::1', family: 6 } as never)
    const result = await resolvedIpIsSsrfSafe('sneaky6.example.com')
    expect(result).toBe(false)
  })

  it('returns false when DNS resolves to ULA fd00::1', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: 'fd00::1', family: 6 } as never)
    const result = await resolvedIpIsSsrfSafe('ula.example.com')
    expect(result).toBe(false)
  })

  it('returns true when DNS resolves to a public IPv6 address', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 } as never)
    const result = await resolvedIpIsSsrfSafe('example.com')
    expect(result).toBe(true)
  })

  it('returns false when DNS lookup fails', async () => {
    vi.mocked(lookup).mockRejectedValue(new Error('ENOTFOUND'))
    const result = await resolvedIpIsSsrfSafe('nonexistent.invalid')
    expect(result).toBe(false)
  })
})
