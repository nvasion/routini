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
} from '../server/src/integrations/providers'

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

  it('is true for all eight v2 catalog ids', () => {
    for (const id of ['azure-devops', 'teams', 'gitlab', 'digitalocean', 'sentry', 'pagerduty', 'datadog', 'cloudflare']) {
      expect(hasProviderTest(id)).toBe(true)
    }
  })

  it('is false for an unknown id', () => {
    expect(hasProviderTest('bogus')).toBe(false)
  })

  it('is false for ttyy (coming soon, no live test yet)', () => {
    expect(hasProviderTest('ttyy')).toBe(false)
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

  it('rejects a non-https scheme', async () => {
    for (const siteUrl of ['ftp://acme.atlassian.net', 'http://acme.atlassian.net']) {
      const result = await runProviderTest('jira', { ...creds, siteUrl }, { ssrfCheck: safeSsrf })
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/must use https/i)
    }
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
    const result = await runProviderTest('jira', { ...creds, siteUrl: 'https://localhost:8080' }, { fetchImpl, ssrfCheck: safeSsrf })
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

// ── Azure DevOps ──────────────────────────────────────────────────────────────

describe('Azure DevOps', () => {
  const creds = { organization: 'contoso', pat: 'super-secret-pat' }

  it('succeeds on 200 with a numeric count', async () => {
    const result = await runProviderTest('azure-devops', creds, { fetchImpl: mockFetch(200, { count: 3, value: [] }) })
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/contoso/)
  })

  it('fails on 401', async () => {
    const result = await runProviderTest('azure-devops', creds, { fetchImpl: mockFetch(401) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })

  it('reports a network failure safely', async () => {
    const result = await runProviderTest('azure-devops', creds, { fetchImpl: failingFetch(new Error('ECONNREFUSED')) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/network error/i)
  })

  it('reports a timeout', async () => {
    const result = await runProviderTest('azure-devops', creds, { fetchImpl: timingOutFetch(), timeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/timed out/i)
  })

  it('rejects an invalid organization name without making any request', async () => {
    const fetchImpl = mockFetch(200, { count: 1 })
    const result = await runProviderTest('azure-devops', { ...creds, organization: 'bad org!' }, { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not valid/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('treats a 203 sign-in-page response as an invalid token', async () => {
    const result = await runProviderTest('azure-devops', creds, { fetchImpl: mockFetch(203, undefined) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/sign-in page/i)
  })

  it('treats a 2xx body without a numeric count as an invalid token', async () => {
    const result = await runProviderTest('azure-devops', creds, { fetchImpl: mockFetch(200, { notCount: true }) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/sign-in page/i)
  })

  it('requests the exact ADO projects URL with a basic-auth PAT header', async () => {
    const fetchImpl = mockFetch(200, { count: 0 })
    await runProviderTest('azure-devops', creds, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://dev.azure.com/contoso/_apis/projects?api-version=7.1&$top=1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Basic ' + Buffer.from(':super-secret-pat', 'utf8').toString('base64'),
        }),
      }),
    )
  })

  it('never includes the PAT in the result message', async () => {
    const result = await runProviderTest('azure-devops', creds, { fetchImpl: mockFetch(401) })
    expect(JSON.stringify(result)).not.toContain('super-secret-pat')
  })
})

// ── Microsoft Teams ───────────────────────────────────────────────────────────

describe('Microsoft Teams', () => {
  const webhookUrl = 'https://prod-01.westus.logic.azure.com/workflows/x'

  it('succeeds on 202 (Workflows webhook response)', async () => {
    const fetchImpl = mockFetch(202, undefined)
    const result = await runProviderTest('teams', { webhookUrl }, { fetchImpl })
    expect(result.ok).toBe(true)
    const [, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [string, RequestInit]
    const parsedBody = JSON.parse(init.body as string)
    expect(parsedBody.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive')
  })

  it('fails on a non-2xx status', async () => {
    const result = await runProviderTest('teams', { webhookUrl }, { fetchImpl: mockFetch(401, undefined) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })

  it('reports a network failure safely', async () => {
    const result = await runProviderTest('teams', { webhookUrl }, { fetchImpl: failingFetch(new Error('ECONNREFUSED')) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/network error/i)
  })

  it('reports a timeout', async () => {
    const result = await runProviderTest('teams', { webhookUrl }, { fetchImpl: timingOutFetch(), timeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/timed out/i)
  })

  it('rejects a non-Microsoft webhook host without making any request', async () => {
    const fetchImpl = mockFetch(202, undefined)
    const result = await runProviderTest('teams', { webhookUrl: 'https://evil.example.com/hook' }, { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not a microsoft webhook host/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a non-https webhook URL without making any request', async () => {
    const fetchImpl = mockFetch(202, undefined)
    const result = await runProviderTest('teams', { webhookUrl: 'http://prod-01.westus.logic.azure.com/workflows/x' }, { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/must use https/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never includes the webhook URL path in a failure message', async () => {
    const result = await runProviderTest('teams', { webhookUrl: 'https://evil.example.com/super-secret-hook-id' }, {})
    expect(JSON.stringify(result)).not.toContain('super-secret-hook-id')
  })
})

// ── GitLab ────────────────────────────────────────────────────────────────────

describe('GitLab', () => {
  const creds = { baseUrl: 'https://gitlab.com', token: 'glpat-secret' }

  it('succeeds on 200', async () => {
    const result = await runProviderTest('gitlab', creds, { fetchImpl: mockFetch(200, { username: 'octocat' }), ssrfCheck: safeSsrf })
    expect(result.ok).toBe(true)
  })

  it('fails on 401', async () => {
    const result = await runProviderTest('gitlab', creds, { fetchImpl: mockFetch(401), ssrfCheck: safeSsrf })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })

  it('reports a network failure safely', async () => {
    const result = await runProviderTest('gitlab', creds, { fetchImpl: failingFetch(new Error('ECONNREFUSED')), ssrfCheck: safeSsrf })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/network error/i)
  })

  it('reports a timeout', async () => {
    const result = await runProviderTest('gitlab', creds, { fetchImpl: timingOutFetch(), timeoutMs: 20, ssrfCheck: safeSsrf })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/timed out/i)
  })

  it('rejects a private-IP base URL when allowPrivateHosts is false, without making any request', async () => {
    const fetchImpl = mockFetch(200, {})
    const result = await runProviderTest('gitlab', { ...creds, baseUrl: 'https://192.168.1.5' }, { fetchImpl, ssrfCheck: safeSsrf })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not allowed/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts a private-IP base URL when allowPrivateHosts is true', async () => {
    const fetchImpl = mockFetch(200, { username: 'local' })
    const result = await runProviderTest('gitlab', { ...creds, baseUrl: 'http://192.168.1.5' }, { fetchImpl, allowPrivateHosts: true })
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('never includes the token in the result message', async () => {
    const result = await runProviderTest('gitlab', creds, { fetchImpl: mockFetch(403), ssrfCheck: safeSsrf })
    expect(JSON.stringify(result)).not.toContain('glpat-secret')
  })
})

// ── DigitalOcean ──────────────────────────────────────────────────────────────

describe('DigitalOcean', () => {
  it('succeeds on 200', async () => {
    const result = await runProviderTest('digitalocean', { token: 'do-tok' }, { fetchImpl: mockFetch(200, { account: {} }) })
    expect(result.ok).toBe(true)
  })

  it('fails on 401', async () => {
    const result = await runProviderTest('digitalocean', { token: 'bad' }, { fetchImpl: mockFetch(401) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })

  it('reports a network failure safely', async () => {
    const result = await runProviderTest('digitalocean', { token: 'x' }, { fetchImpl: failingFetch(new Error('ECONNREFUSED')) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/network error/i)
  })

  it('reports a timeout', async () => {
    const result = await runProviderTest('digitalocean', { token: 'x' }, { fetchImpl: timingOutFetch(), timeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/timed out/i)
  })

  it('never includes the token in the result message', async () => {
    const result = await runProviderTest('digitalocean', { token: 'do-secret-tok' }, { fetchImpl: mockFetch(401) })
    expect(JSON.stringify(result)).not.toContain('do-secret-tok')
  })
})

// ── Sentry ────────────────────────────────────────────────────────────────────

describe('Sentry', () => {
  it('succeeds on 200', async () => {
    const result = await runProviderTest('sentry', { token: 'sentry-tok' }, { fetchImpl: mockFetch(200, []) })
    expect(result.ok).toBe(true)
  })

  it('fails on 401', async () => {
    const result = await runProviderTest('sentry', { token: 'bad' }, { fetchImpl: mockFetch(401) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })

  it('reports a network failure safely', async () => {
    const result = await runProviderTest('sentry', { token: 'x' }, { fetchImpl: failingFetch(new Error('ECONNREFUSED')) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/network error/i)
  })

  it('reports a timeout', async () => {
    const result = await runProviderTest('sentry', { token: 'x' }, { fetchImpl: timingOutFetch(), timeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/timed out/i)
  })

  it('never includes the token in the result message', async () => {
    const result = await runProviderTest('sentry', { token: 'sentry-secret-tok' }, { fetchImpl: mockFetch(401) })
    expect(JSON.stringify(result)).not.toContain('sentry-secret-tok')
  })
})

// ── PagerDuty ─────────────────────────────────────────────────────────────────

describe('PagerDuty', () => {
  it('succeeds on 200', async () => {
    const result = await runProviderTest('pagerduty', { apiKey: 'pd-key' }, { fetchImpl: mockFetch(200, {}) })
    expect(result.ok).toBe(true)
  })

  it('fails on 401', async () => {
    const result = await runProviderTest('pagerduty', { apiKey: 'bad' }, { fetchImpl: mockFetch(401) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })

  it('reports a network failure safely', async () => {
    const result = await runProviderTest('pagerduty', { apiKey: 'x' }, { fetchImpl: failingFetch(new Error('ECONNREFUSED')) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/network error/i)
  })

  it('reports a timeout', async () => {
    const result = await runProviderTest('pagerduty', { apiKey: 'x' }, { fetchImpl: timingOutFetch(), timeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/timed out/i)
  })

  it('never includes the API key in the result message', async () => {
    const result = await runProviderTest('pagerduty', { apiKey: 'pd-secret-key' }, { fetchImpl: mockFetch(401) })
    expect(JSON.stringify(result)).not.toContain('pd-secret-key')
  })
})

// ── Datadog ───────────────────────────────────────────────────────────────────

describe('Datadog', () => {
  const creds = { apiUrl: 'https://api.datadoghq.com', apiKey: 'dd-api-key', appKey: 'dd-app-key' }

  it('succeeds on 200 with valid:true', async () => {
    const result = await runProviderTest('datadog', creds, { fetchImpl: mockFetch(200, { valid: true }) })
    expect(result.ok).toBe(true)
  })

  it('fails on 200 with valid:false', async () => {
    const result = await runProviderTest('datadog', creds, { fetchImpl: mockFetch(200, { valid: false }) })
    expect(result.ok).toBe(false)
  })

  it('fails on 403', async () => {
    const result = await runProviderTest('datadog', creds, { fetchImpl: mockFetch(403, { valid: false }) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/403/)
  })

  it('reports a network failure safely', async () => {
    const result = await runProviderTest('datadog', creds, { fetchImpl: failingFetch(new Error('ECONNREFUSED')) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/network error/i)
  })

  it('reports a timeout', async () => {
    const result = await runProviderTest('datadog', creds, { fetchImpl: timingOutFetch(), timeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/timed out/i)
  })

  it('rejects a non-Datadog API URL without making any request', async () => {
    const fetchImpl = mockFetch(200, { valid: true })
    const result = await runProviderTest('datadog', { ...creds, apiUrl: 'https://api.evil.com' }, { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/must be https/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never includes the API key or app key in the result message', async () => {
    const result = await runProviderTest('datadog', creds, { fetchImpl: mockFetch(403, { valid: false }) })
    const json = JSON.stringify(result)
    expect(json).not.toContain('dd-api-key')
    expect(json).not.toContain('dd-app-key')
  })
})

// ── Cloudflare ────────────────────────────────────────────────────────────────

describe('Cloudflare', () => {
  it('succeeds on 200 with success:true and status active', async () => {
    const result = await runProviderTest(
      'cloudflare',
      { token: 'cf-tok' },
      { fetchImpl: mockFetch(200, { success: true, result: { status: 'active' } }) },
    )
    expect(result.ok).toBe(true)
  })

  it('reports not-active when success:true but status is disabled', async () => {
    const result = await runProviderTest(
      'cloudflare',
      { token: 'cf-tok' },
      { fetchImpl: mockFetch(200, { success: true, result: { status: 'disabled' } }) },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not active/i)
  })

  it('fails on 401', async () => {
    const result = await runProviderTest('cloudflare', { token: 'bad' }, { fetchImpl: mockFetch(401) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })

  it('reports a network failure safely', async () => {
    const result = await runProviderTest('cloudflare', { token: 'x' }, { fetchImpl: failingFetch(new Error('ECONNREFUSED')) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/network error/i)
  })

  it('reports a timeout', async () => {
    const result = await runProviderTest('cloudflare', { token: 'x' }, { fetchImpl: timingOutFetch(), timeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/timed out/i)
  })

  it('never includes the token in the result message', async () => {
    const result = await runProviderTest('cloudflare', { token: 'cf-secret-tok' }, { fetchImpl: mockFetch(401) })
    expect(JSON.stringify(result)).not.toContain('cf-secret-tok')
  })
})
