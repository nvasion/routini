import { describe, it, expect } from 'vitest'
import { validateRepoUrl } from '../server/src/utils/repoUrl'

describe('validateRepoUrl', () => {
  // ── Happy paths ───────────────────────────────────────────────────────────

  it('accepts a valid github.com https URL', () => {
    const result = validateRepoUrl('https://github.com/owner/repo')
    expect(result.valid).toBe(true)
  })

  it('accepts a valid gitlab.com https URL', () => {
    const result = validateRepoUrl('https://gitlab.com/group/project')
    expect(result.valid).toBe(true)
  })

  it('accepts a valid bitbucket.org https URL', () => {
    const result = validateRepoUrl('https://bitbucket.org/team/repo.git')
    expect(result.valid).toBe(true)
  })

  it('accepts a valid dev.azure.com https URL', () => {
    const result = validateRepoUrl('https://dev.azure.com/org/project/_git/repo')
    expect(result.valid).toBe(true)
  })

  it('accepts a subdomain of an allowed host (gist.github.com)', () => {
    const result = validateRepoUrl('https://gist.github.com/user/abc123')
    expect(result.valid).toBe(true)
  })

  it('exposes the parsed URL object on success', () => {
    const result = validateRepoUrl('https://github.com/owner/repo')
    if (!result.valid) throw new Error('Expected valid')
    expect(result.url.hostname).toBe('github.com')
  })

  // ── Protocol checks ───────────────────────────────────────────────────────

  it('rejects http:// (insecure protocol)', () => {
    const result = validateRepoUrl('http://github.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/https/i)
  })

  it('rejects ssh:// protocol', () => {
    const result = validateRepoUrl('ssh://github.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/https/i)
  })

  it('rejects git:// protocol', () => {
    const result = validateRepoUrl('git://github.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/https/i)
  })

  it('rejects file:// protocol', () => {
    const result = validateRepoUrl('file:///etc/passwd')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/https/i)
  })

  // ── Host allowlist checks ─────────────────────────────────────────────────

  it('rejects an unknown host (example.com)', () => {
    const result = validateRepoUrl('https://example.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/hostname/i)
  })

  it('rejects an internal IP address (SSRF)', () => {
    const result = validateRepoUrl('https://192.168.1.1/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/hostname/i)
  })

  it('rejects localhost (SSRF)', () => {
    const result = validateRepoUrl('https://localhost/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/hostname/i)
  })

  it('rejects a domain that only contains the allowed host as a suffix trick', () => {
    // e.g. "evil-github.com" – contains "github.com" but does NOT end with ".github.com"
    const result = validateRepoUrl('https://evil-github.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/hostname/i)
  })

  // ── Credential checks ─────────────────────────────────────────────────────

  it('rejects URLs with embedded username:password', () => {
    const result = validateRepoUrl('https://user:secret@github.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/credential/i)
  })

  // ── Port checks ───────────────────────────────────────────────────────────

  it('rejects a non-standard port', () => {
    const result = validateRepoUrl('https://github.com:8443/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/port/i)
  })

  it('accepts explicit default port 443', () => {
    const result = validateRepoUrl('https://github.com:443/owner/repo')
    expect(result.valid).toBe(true)
  })

  // ── Path checks ───────────────────────────────────────────────────────────

  it('rejects a URL with no repository path', () => {
    const result = validateRepoUrl('https://github.com/')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/path/i)
  })

  // ── Input sanity ─────────────────────────────────────────────────────────

  it('rejects an empty string', () => {
    const result = validateRepoUrl('')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/required/i)
  })

  it('rejects a non-URL string', () => {
    const result = validateRepoUrl('not a url at all')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/valid URL/i)
  })
})

