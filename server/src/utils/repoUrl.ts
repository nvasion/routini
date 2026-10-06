// ─────────────────────────────────────────────────────────────────────────────
// Repository URL validation (SSRF guard for agent steps)
//
// Only https:// URLs on an allow-listed git host (or a subdomain of one) are
// accepted: no other schemes, embedded credentials or non-standard ports.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allowlist of git-hosting hostnames.
 * Subdomains of these hosts are also accepted (e.g. gist.github.com).
 */
const ALLOWED_GIT_HOSTS: readonly string[] = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'dev.azure.com',
]

export type UrlValidResult = { valid: true; url: URL } | { valid: false; error: string }

/**
 * Validates that a repository URL is safe to pass to Docker.
 *
 * Rules enforced:
 *   1. Must be parseable as a URL.
 *   2. Must use the `https:` protocol (prevents file://, git://, ssh://, etc.).
 *   3. Hostname must match the git-host allowlist (prevents SSRF to internal services).
 *   4. Must not embed credentials (user:pass@host).
 *   5. Must not use a non-standard port.
 *   6. Must include a non-empty repository path.
 */
export function validateRepoUrl(rawUrl: string): UrlValidResult {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { valid: false, error: 'repoUrl is required' }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return { valid: false, error: 'repoUrl is not a valid URL' }
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'repoUrl must use the https:// protocol' }
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'repoUrl must not contain embedded credentials' }
  }

  if (parsed.port !== '' && parsed.port !== '443') {
    return { valid: false, error: 'repoUrl must not specify a non-standard port' }
  }

  const isAllowedHost = ALLOWED_GIT_HOSTS.some(
    host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
  )
  if (!isAllowedHost) {
    return {
      valid: false,
      error: `repoUrl hostname is not an allowed git host. Allowed: ${ALLOWED_GIT_HOSTS.join(', ')}`,
    }
  }

  if (!parsed.pathname || parsed.pathname === '/') {
    return { valid: false, error: 'repoUrl must include a repository path' }
  }

  return { valid: true, url: parsed }
}

