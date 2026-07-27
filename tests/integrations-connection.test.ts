/**
 * Unit tests for testIntegrationConnection (server/src/routes/integrations.ts)
 * — the provider-specific live-check dispatch used by
 * POST /api/integrations/:id/test. Exercised directly with an injected
 * fetch/SSRF-check (mirrors the pattern in tests/http.test.ts) so no real
 * network access is required.
 */
import { describe, it, expect, vi } from 'vitest'
import { testIntegrationConnection } from '../server/src/routes/integrations'

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

describe('testIntegrationConnection', () => {
  it('github: reports ok on a successful /user call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}))
    const result = await testIntegrationConnection('github', { token: 'ghp_x' }, { fetchImpl })
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer ghp_x' }) }),
    )
  })

  it('github: reports failure with the response status on a 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, {}))
    const result = await testIntegrationConnection('github', { token: 'bad' }, { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/401/)
  })

  it('slack: reports ok when auth.test returns ok:true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    const result = await testIntegrationConnection('slack', { botToken: 'xoxb-x' }, { fetchImpl })
    expect(result.ok).toBe(true)
  })

  it('slack: reports failure with the Slack error string when ok:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: false, error: 'invalid_auth' }))
    const result = await testIntegrationConnection('slack', { botToken: 'bad' }, { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/invalid_auth/)
  })

  it('jira: rejects a non-https siteUrl without making a network call', async () => {
    const fetchImpl = vi.fn()
    const result = await testIntegrationConnection(
      'jira',
      { siteUrl: 'http://example.atlassian.net', email: 'a@b.com', apiToken: 'tok' },
      { fetchImpl },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/https/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('jira: rejects a siteUrl that resolves to a private address (SSRF guard)', async () => {
    const fetchImpl = vi.fn()
    const ssrfCheck = vi.fn().mockResolvedValue(false)
    const result = await testIntegrationConnection(
      'jira',
      { siteUrl: 'https://internal.example.com', email: 'a@b.com', apiToken: 'tok' },
      { fetchImpl, ssrfCheck },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/private|disallowed/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('jira: reports ok on a successful /myself call for a safe siteUrl', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}))
    const ssrfCheck = vi.fn().mockResolvedValue(true)
    const result = await testIntegrationConnection(
      'jira',
      { siteUrl: 'https://example.atlassian.net', email: 'a@b.com', apiToken: 'tok' },
      { fetchImpl, ssrfCheck },
    )
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.atlassian.net/rest/api/3/myself',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Basic /) }) }),
    )
  })

  it('notion: reports ok on a successful /users/me call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}))
    const result = await testIntegrationConnection('notion', { token: 'secret_x' }, { fetchImpl })
    expect(result.ok).toBe(true)
  })

  it('linear: reports ok when the viewer query returns an id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { viewer: { id: 'u1' } } }))
    const result = await testIntegrationConnection('linear', { apiKey: 'lin_api_x' }, { fetchImpl })
    expect(result.ok).toBe(true)
  })

  it('linear: reports failure when the viewer query has no data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}))
    const result = await testIntegrationConnection('linear', { apiKey: 'bad' }, { fetchImpl })
    expect(result.ok).toBe(false)
  })

  it('monday: reports ok when the me query returns an id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { me: { id: 'u1' } } }))
    const result = await testIntegrationConnection('monday', { apiToken: 'tok' }, { fetchImpl })
    expect(result.ok).toBe(true)
  })

  it('hubspot: reports ok on a successful account-info call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}))
    const result = await testIntegrationConnection('hubspot', { token: 'pat-x' }, { fetchImpl })
    expect(result.ok).toBe(true)
  })

  it('returns a failure result (not a throw) when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const result = await testIntegrationConnection('github', { token: 'x' }, { fetchImpl })
    expect(result.ok).toBe(false)
  })

  it('reports an unsupported-integration failure for an unknown id', async () => {
    const result = await testIntegrationConnection('bogus', {}, { fetchImpl: vi.fn() })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Unsupported/)
  })
})
