/**
 * Unit tests for the per-provider live health checks
 * (server/src/services/integrationProviders.ts).
 *
 * Each provider is exercised for:
 *   – a valid-credential success response
 *   – a provider-reported auth failure (4xx, or 200+ok:false for Slack)
 *   – a network failure (fetch rejects)
 *   – a request timeout (AbortController fires)
 *
 * Jira additionally covers SSRF rejection of private/loopback site URLs and
 * malformed URLs, since its siteUrl field is the one piece of user-controlled
 * URL input among the seven providers.
 *
 * fetch and the DNS-based SSRF check are injected via ProviderTestContext so
 * no real network calls are made, mirroring the pattern used by
 * tests/http.test.ts for the HTTP daily-task service.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  runProviderTest,
  hasProviderTest,
  type FetchFn,
} from '../server/src/services/integrationProviders'

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response
}

function mockFetch(status: number, body: unknown = {}): FetchFn {
  return vi.fn().mockResolvedValue(jsonResponse(status, body))
}

function failingFetch(err: unknown): FetchFn {
  return vi.fn().mockRejectedValue(err)
}

function timingOutFetch(): FetchFn {
  return vi.fn().mockImplementation(
    (_url: string, opts?: RequestInit) =>
      new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }),
  )
}

const safeSsrf = async () => true
const unsafeSsrf = async () => false

// ── Registry ──────────────────────────────────────────────────────────────────

describe('hasProviderTest', () => {
  it('is true for all seven v1 catalog ids', () => {
    for (const id of ['github', 'slack', 'jira', 'notion', 'linear', 'monday', 'hubspot']) {
      expect(hasProviderTest(id)).toBe(true)
    }
  })

  it('is false for an unknown id', () => {
    expect(hasProviderTest('bogus')).toBe(false)
  })
})

describe('runProviderTest', () => {
  it('throws for an id with no registered test', async () => {
    await expect(runProviderTest('bogus', {})).rejects.toThrow(/no provider test/i)
  })
})

// ── GitHub ────────────────────────────────────────────────────────────────────

describe('GitHub', () => {
  it('succeeds on 200', async () => {
    const result = await runProviderTest('github', { token: 'gh-token' }, { fetchImpl: mockFetch(200, { login: 'octocat' }) })
    expect(result.ok).toBe(true)
  })

  it('fails on 401 (bad token)', async () => {
    const result = await runProviderTest('github', { token: 'bad' }, { fetchImpl: mockFetch(401) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })

  it('never includes the token in the result message', async () => {
    const result = await runProviderTest('github', { token: 'super-secret-pat' }, { fetchImpl: mockFetch(401) })
    expect(JSON.stringify(result)).not.toContain('super-secret-pat')
  })

  it('reports a network failure safely', async () => {
    const result = await runProviderTest('github', { token: 'x' }, { fetchImpl: failingFetch(new Error('ECONNREFUSED')) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/network error/i)
  })

  it('reports a timeout', async () => {
    const result = await runProviderTest(
      'github',
      { token: 'x' },
      { fetchImpl: timingOutFetch(), timeoutMs: 20 },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/timed out/i)
  })
})

// ── Slack ─────────────────────────────────────────────────────────────────────

describe('Slack', () => {
  it('succeeds when auth.test returns ok:true', async () => {
    const result = await runProviderTest(
      'slack',
      { botToken: 'xoxb-good' },
      { fetchImpl: mockFetch(200, { ok: true, team: 'Acme' }) },
    )
    expect(result.ok).toBe(true)
  })

  it('fails when auth.test returns ok:false with an error code (still HTTP 200)', async () => {
    const result = await runProviderTest(
      'slack',
      { botToken: 'xoxb-bad' },
      { fetchImpl: mockFetch(200, { ok: false, error: 'invalid_auth' }) },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/invalid_auth/)
  })

  it('fails on a non-2xx HTTP status', async () => {
    const result = await runProviderTest('slack', { botToken: 'x' }, { fetchImpl: mockFetch(500, {}) })
    expect(result.ok).toBe(false)
  })
})

// ── Jira ──────────────────────────────────────────────────────────────────────

describe('Jira', () => {
  const creds = { apiToken: 'tok', siteUrl: 'https://acme.atlassian.net', email: 'a@acme.com' }

  it('succeeds on 200', async () => {
    const result = await runProviderTest('jira', creds, {
      fetchImpl: mockFetch(200, { accountId: '123' }),
      ssrfCheck: safeSsrf,
    })
    expect(result.ok).toBe(true)
  })

  it('fails on 401', async () => {
    const result = await runProviderTest('jira', creds, {
      fetchImpl: mockFetch(401),
      ssrfCheck: safeSsrf,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })

  it('rejects a malformed site URL', async () => {
    const result = await runProviderTest('jira', { ...creds, siteUrl: 'not a url' }, { ssrfCheck: safeSsrf })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not a valid url/i)
  })

  it('rejects a non-http(s) scheme', async () => {
    const result = await runProviderTest('jira', { ...creds, siteUrl: 'ftp://acme.atlassian.net' }, { ssrfCheck: safeSsrf })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/http or https/i)
  })

  it('rejects a site URL with embedded credentials', async () => {
    const result = await runProviderTest(
      'jira',
      { ...creds, siteUrl: 'https://user:pass@acme.atlassian.net' },
      { ssrfCheck: safeSsrf },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/embedded credentials/i)
  })

  it('rejects a loopback/private hostname before making any request', async () => {
    const fetchImpl = mockFetch(200, {})
    const result = await runProviderTest('jira', { ...creds, siteUrl: 'http://localhost:8080' }, { fetchImpl, ssrfCheck: safeSsrf })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not allowed/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects when the DNS-resolved IP is private (rebinding guard)', async () => {
    const result = await runProviderTest('jira', creds, {
      fetchImpl: mockFetch(200, {}),
      ssrfCheck: unsafeSsrf,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not allowed/i)
  })

  it('never includes the API token in the result message', async () => {
    const result = await runProviderTest('jira', { ...creds, apiToken: 'super-secret-jira-token' }, {
      fetchImpl: mockFetch(403),
      ssrfCheck: safeSsrf,
    })
    expect(JSON.stringify(result)).not.toContain('super-secret-jira-token')
  })
})

// ── Notion ────────────────────────────────────────────────────────────────────

describe('Notion', () => {
  it('succeeds on 200', async () => {
    const result = await runProviderTest('notion', { token: 'secret_x' }, { fetchImpl: mockFetch(200, { id: 'u1' }) })
    expect(result.ok).toBe(true)
  })

  it('fails on 401', async () => {
    const result = await runProviderTest('notion', { token: 'bad' }, { fetchImpl: mockFetch(401) })
    expect(result.ok).toBe(false)
  })
})

// ── Linear ────────────────────────────────────────────────────────────────────

describe('Linear', () => {
  it('succeeds when the viewer graphql query resolves', async () => {
    const result = await runProviderTest(
      'linear',
      { apiKey: 'lin_api_x' },
      { fetchImpl: mockFetch(200, { data: { viewer: { id: 'v1' } } }) },
    )
    expect(result.ok).toBe(true)
  })

  it('fails when the graphql response carries errors', async () => {
    const result = await runProviderTest(
      'linear',
      { apiKey: 'bad' },
      { fetchImpl: mockFetch(200, { errors: [{ message: 'Authentication required' }] }) },
    )
    expect(result.ok).toBe(false)
  })

  it('fails on a non-2xx status', async () => {
    const result = await runProviderTest('linear', { apiKey: 'x' }, { fetchImpl: mockFetch(500, {}) })
    expect(result.ok).toBe(false)
  })
})

// ── monday.com ────────────────────────────────────────────────────────────────

describe('monday.com', () => {
  it('succeeds when the me graphql query resolves', async () => {
    const result = await runProviderTest(
      'monday',
      { apiToken: 'tok' },
      { fetchImpl: mockFetch(200, { data: { me: { id: 42 } } }) },
    )
    expect(result.ok).toBe(true)
  })

  it('fails when the graphql response carries errors', async () => {
    const result = await runProviderTest(
      'monday',
      { apiToken: 'bad' },
      { fetchImpl: mockFetch(200, { errors: [{ message: 'Unauthorized' }] }) },
    )
    expect(result.ok).toBe(false)
  })
})

// ── HubSpot ───────────────────────────────────────────────────────────────────

describe('HubSpot', () => {
  it('succeeds on 200', async () => {
    const result = await runProviderTest('hubspot', { token: 'tok' }, { fetchImpl: mockFetch(200, { portalId: 1 }) })
    expect(result.ok).toBe(true)
  })

  it('fails on 401', async () => {
    const result = await runProviderTest('hubspot', { token: 'bad' }, { fetchImpl: mockFetch(401) })
    expect(result.ok).toBe(false)
  })
})
