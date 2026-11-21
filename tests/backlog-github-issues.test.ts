/**
 * Unit tests for the GitHub Issues backlog source adapter
 * (server/src/backlog/githubIssues.ts). Pure module: no database, no real
 * network. Every test supplies a recording fake `fetch` so the adapter is
 * exercised exactly as the scheduler's sync/write ticks would call it
 * (contract: docs/work-intake-backlog.md section 6b "githubIssues.ts").
 */

import { describe, it, expect } from 'vitest'
import { SpecError } from '../server/src/engine/spec'
import { githubIssuesAdapter } from '../server/src/backlog/index'
import { parseGithubIssuesConfig, type GithubIssuesConfig } from '../server/src/backlog/githubIssues'
import type { AdapterCtx } from '../server/src/backlog/types'
import type { FetchFn } from '../server/src/integrations/providers'

// ── Fake fetch ────────────────────────────────────────────────────────────────

interface FakeResponse {
  status: number
  json: unknown
}

interface RecordedCall {
  method: string
  url: string
  body: any
  redirect: RequestRedirect | undefined
}

/** A fetch that answers from a fixed queue of responses, in call order, and records every call. */
function fakeFetch(responses: FakeResponse[]): { fetch: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let i = 0
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, url, body, redirect: init?.redirect })
    const r = responses[Math.min(i, responses.length - 1)]!
    i += 1
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.json,
    } as unknown as Response
  }) as FetchFn
  return { fetch, calls }
}

function ctxWith(fetch: FetchFn, token = 'gh-token'): AdapterCtx {
  return {
    fetch,
    credentials: async () => ({ token }),
    allowPrivateHosts: false,
  }
}

function cfg(overrides: Partial<Parameters<typeof parseGithubIssuesConfig>[0]> = {}): GithubIssuesConfig {
  return parseGithubIssuesConfig({ repoUrl: 'https://github.com/acme/app', ...overrides })
}

function issue(
  number: number,
  overrides: Partial<{ title: string; body: string; html_url: string; state: string; labels: unknown[]; pull_request: unknown }> = {},
): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    body: 'Body text',
    html_url: `https://github.com/acme/app/issues/${number}`,
    state: 'open',
    labels: [],
    ...overrides,
  }
}

// ── parseConfig ────────────────────────────────────────────────────────────────

describe('parseGithubIssuesConfig', () => {
  it('rejects a repoUrl that is not a github.com URL, with the same message as the repo source', () => {
    expect(() => parseGithubIssuesConfig({ repoUrl: 'https://gitlab.com/acme/app' })).toThrow(
      'repoUrl must be a https://github.com/<owner>/<repo> URL',
    )
  })

  it('derives owner/repo and defaults statusPrefix to "status:"', () => {
    const c = parseGithubIssuesConfig({ repoUrl: 'https://github.com/acme/app' })
    expect(c.owner).toBe('acme')
    expect(c.repo).toBe('app')
    expect(c.statusPrefix).toBe('status:')
    expect(c.labels).toBeUndefined()
  })

  it('accepts a custom statusPrefix and labels filter', () => {
    const c = parseGithubIssuesConfig({ repoUrl: 'https://github.com/acme/app', statusPrefix: 'state:', labels: ['bug', 'p1'] })
    expect(c.statusPrefix).toBe('state:')
    expect(c.labels).toEqual(['bug', 'p1'])
  })

  it('rejects an empty or oversized statusPrefix', () => {
    expect(() => parseGithubIssuesConfig({ repoUrl: 'https://github.com/acme/app', statusPrefix: '' })).toThrow(SpecError)
    expect(() => parseGithubIssuesConfig({ repoUrl: 'https://github.com/acme/app', statusPrefix: 'x'.repeat(61) })).toThrow(
      'config.statusPrefix must be a non-empty string of at most 60 characters',
    )
  })

  it('rejects a labels list that is not an array of short non-empty strings', () => {
    expect(() => parseGithubIssuesConfig({ repoUrl: 'https://github.com/acme/app', labels: 'bug' })).toThrow(SpecError)
    expect(() => parseGithubIssuesConfig({ repoUrl: 'https://github.com/acme/app', labels: [''] })).toThrow(SpecError)
    expect(() => parseGithubIssuesConfig({ repoUrl: 'https://github.com/acme/app', labels: Array.from({ length: 21 }, (_, i) => `l${i}`) })).toThrow(
      'config.labels must be a list of at most 20 non-empty strings of at most 60 characters',
    )
  })
})

// ── fetch ────────────────────────────────────────────────────────────────────

describe('githubIssuesAdapter.fetch', () => {
  it('skips pull requests (issues carrying a pull_request field)', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: [issue(1), { ...issue(2), pull_request: { url: 'x' } }] }])
    const ctx = ctxWith(fetch)

    const items = await githubIssuesAdapter.fetch(ctx, cfg())

    expect(items.map((i) => i.externalId)).toEqual(['1'])
    expect(items[0]!.position).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/repos/acme/app/issues?state=all&per_page=100&page=1')
    expect(calls[0]!.redirect).toBe('manual')
  })

  it('reads state from the prefixed status label, stripping it from the reported labels', async () => {
    const { fetch } = fakeFetch([{ status: 200, json: [issue(1, { labels: [{ name: 'status:In progress' }, { name: 'bug' }] })] }])
    const ctx = ctxWith(fetch)

    const items = await githubIssuesAdapter.fetch(ctx, cfg())

    expect(items[0]!.state).toBe('In progress')
    expect(items[0]!.labels).toEqual(['bug'])
  })

  it('falls back to open/closed when there is no status label', async () => {
    const { fetch } = fakeFetch([{ status: 200, json: [issue(1, { state: 'open' }), issue(2, { state: 'closed' })] }])
    const ctx = ctxWith(fetch)

    const items = await githubIssuesAdapter.fetch(ctx, cfg())

    expect(items.map((i) => i.state)).toEqual(['open', 'closed'])
  })

  it('reports labels unchanged when none of them carry the status prefix', async () => {
    const { fetch } = fakeFetch([{ status: 200, json: [issue(1, { labels: [{ name: 'bug' }, { name: 'urgent' }] })] }])
    const ctx = ctxWith(fetch)

    const items = await githubIssuesAdapter.fetch(ctx, cfg())

    expect(items[0]!.labels).toEqual(['bug', 'urgent'])
    expect(items[0]!.state).toBe('open')
  })

  it('adds the label filter to the query when configured', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: [] }])
    const ctx = ctxWith(fetch)

    await githubIssuesAdapter.fetch(ctx, cfg({ labels: ['bug', 'p1'] }))

    expect(calls[0]!.url).toContain(`labels=${encodeURIComponent('bug,p1')}`)
  })

  it('pages at 100 per page and stops once a short page is returned', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => issue(i + 1))
    const page2 = [issue(101), issue(102)]
    const { fetch, calls } = fakeFetch([
      { status: 200, json: page1 },
      { status: 200, json: page2 },
    ])
    const ctx = ctxWith(fetch)

    const items = await githubIssuesAdapter.fetch(ctx, cfg())

    expect(items).toHaveLength(102)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain('page=1')
    expect(calls[1]!.url).toContain('page=2')
  })

  it('stops paging at 500 items without requesting a 6th page', async () => {
    const fullPage = () => Array.from({ length: 100 }, (_, i) => issue(i + 1))
    const { fetch, calls } = fakeFetch([
      { status: 200, json: fullPage() },
      { status: 200, json: fullPage() },
      { status: 200, json: fullPage() },
      { status: 200, json: fullPage() },
      { status: 200, json: fullPage() },
      { status: 200, json: fullPage() }, // would be page 6; must never be fetched
    ])
    const ctx = ctxWith(fetch)

    const items = await githubIssuesAdapter.fetch(ctx, cfg())

    expect(items).toHaveLength(500)
    expect(calls).toHaveLength(5)
  })

  it('surfaces a tracker error without leaking the token', async () => {
    const { fetch } = fakeFetch([{ status: 404, json: { message: 'Not Found' } }])
    const ctx = ctxWith(fetch, 'super-secret-token')

    await expect(githubIssuesAdapter.fetch(ctx, cfg())).rejects.toThrow(/Not Found/)
    await expect(githubIssuesAdapter.fetch(ctx, cfg())).rejects.not.toThrow(/super-secret-token/)
  })
})

// ── write ────────────────────────────────────────────────────────────────────

describe('githubIssuesAdapter.write', () => {
  const item = { externalId: '42', title: 'Fix bug', url: null }

  it('writes open/closed via PATCH on the issue', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { number: 42, state: 'closed' } }])
    const ctx = ctxWith(fetch)

    await githubIssuesAdapter.write(ctx, cfg(), item, { value: 'Closed' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.url).toContain('/repos/acme/app/issues/42')
    expect(calls[0]!.body).toEqual({ state: 'closed' })
  })

  it('swaps the status label for any other value, removing every old status label', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { number: 42, labels: [{ name: 'status:Planning' }, { name: 'status:Stale' }, { name: 'bug' }] } },
      { status: 200, json: {} }, // DELETE status:Planning
      { status: 200, json: {} }, // DELETE status:Stale
      { status: 200, json: [{ name: 'status:In progress' }, { name: 'bug' }] }, // POST labels
    ])
    const ctx = ctxWith(fetch)

    await githubIssuesAdapter.write(ctx, cfg(), item, { value: 'In progress' })

    expect(calls).toHaveLength(4)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: expect.stringContaining(`/labels/${encodeURIComponent('status:Planning')}`) })
    expect(calls[2]).toMatchObject({ method: 'DELETE', url: expect.stringContaining(`/labels/${encodeURIComponent('status:Stale')}`) })
    expect(calls[3]!.method).toBe('POST')
    expect(calls[3]!.url).toContain('/repos/acme/app/issues/42/labels')
    expect(calls[3]!.body).toEqual({ labels: ['status:In progress'] })
  })

  it('URL-encodes label names in the DELETE path', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { number: 42, labels: [{ name: 'status:In progress' }] } },
      { status: 200, json: {} },
      { status: 200, json: [] },
    ])
    const ctx = ctxWith(fetch)

    await githubIssuesAdapter.write(ctx, cfg(), item, { value: 'Building' })

    expect(calls[1]!.url).toContain('/labels/status%3AIn%20progress')
  })

  it('swapping the label when there was no prior status label only adds the new one', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { number: 42, labels: [{ name: 'bug' }] } },
      { status: 200, json: [{ name: 'status:Building' }, { name: 'bug' }] },
    ])
    const ctx = ctxWith(fetch)

    await githubIssuesAdapter.write(ctx, cfg(), item, { value: 'Building' })

    expect(calls).toHaveLength(2)
    expect(calls[1]!.method).toBe('POST')
    expect(calls[1]!.body).toEqual({ labels: ['status:Building'] })
  })

  it('posts a comment after the status change when one is given', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { number: 42, state: 'open' } }, { status: 201, json: { id: 1 } }])
    const ctx = ctxWith(fetch)

    await githubIssuesAdapter.write(ctx, cfg(), item, { value: 'Open', comment: 'Reopened by Routini' })

    expect(calls).toHaveLength(2)
    expect(calls[1]!.method).toBe('POST')
    expect(calls[1]!.url).toBe('https://api.github.com/repos/acme/app/issues/42/comments')
    expect(calls[1]!.body).toEqual({ body: 'Reopened by Routini' })
  })

  it('surfaces a tracker error without leaking the token', async () => {
    const { fetch } = fakeFetch([{ status: 422, json: { message: 'Validation failed' } }])
    const ctx = ctxWith(fetch, 'super-secret-token')

    await expect(githubIssuesAdapter.write(ctx, cfg(), item, { value: 'Open' })).rejects.toThrow(/Validation failed/)
  })
})
